import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemDetailDialog } from '@/components/item-detail-dialog'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/hooks/query-keys'
import type { Item, ItemListResponse } from '@/lib/types'
import { toast } from 'sonner'

vi.unmock('next-intl')
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  setAccessToken: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

function catalog(namespace: string) {
  return JSON.parse(readFileSync(resolve(__dirname, '..', 'messages', 'en', `${namespace}.json`), 'utf8'))
}
const careLabel = catalog('wardrobe').itemDetail.careLabel

const item = {
  id: 'i1',
  type: 'shirt',
  status: 'ready',
  tags: { colors: ['navy'], style: [], season: [] },
  images: [],
  image_url: 'https://example.test/i1.jpg?x=1',
  thumbnail_url: 'https://example.test/i1-thumb.jpg',
  wear_count: 0,
  wears_since_wash: 0,
  effective_wash_interval: 3,
} as unknown as Item

let client: QueryClient

function Wrapper({ children }: { children: ReactNode }) {
  const all = Object.fromEntries(['wardrobe', 'constants', 'common'].map((ns) => [ns, catalog(ns)]))
  return (
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={all} onError={() => {}}>
        {children}
      </NextIntlClientProvider>
    </QueryClientProvider>
  )
}

function renderDialog(overrides: Partial<Item> = {}, aiUiEnabled = true) {
  client.setQueryData(queryKeys.features, {
    background_removal: false,
    max_upload_size_mb: 1,
    ai_ui_enabled: aiUiEnabled,
  })
  const current = { ...item, ...overrides } as Item
  client.setQueryData<ItemListResponse>(queryKeys.items.list({}, 1, 20), {
    items: [current],
    total: 1,
    page: 1,
    page_size: 20,
    has_more: false,
  } as unknown as ItemListResponse)
  return render(<ItemDetailDialog item={current} open onOpenChange={() => {}} />, { wrapper: Wrapper })
}

function pickFile(file = new File(['x'], 'label.jpg', { type: 'image/jpeg' })) {
  fireEvent.change(screen.getByTestId('care-label-input'), { target: { files: [file] } })
}

function respond(status: number, body: unknown) {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  )
}

describe('care label upload', () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.mocked(api.get).mockReset()
    vi.mocked(api.get).mockResolvedValue([])
    vi.stubGlobal('fetch', vi.fn())
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.success).mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows care instructions the item already has', () => {
    renderDialog({ tags: { ...item.tags, care_instructions: 'Hand wash cold.' } })
    expect(screen.getByText('Hand wash cold.')).toBeInTheDocument()
  })

  it('says there are none yet otherwise', () => {
    renderDialog()
    expect(screen.getByText(careLabel.empty)).toBeInTheDocument()
  })

  it('posts the photo as the image field and caches the sentence it gets back', async () => {
    respond(200, { care_label: 'Machine wash at 30°C, do not tumble dry.' })
    renderDialog()
    pickFile()

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(careLabel.success))
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('/api/v1/items/i1/care-label')
    expect(init?.method).toBe('POST')
    expect((init?.body as FormData).get('image')).toBeInstanceOf(File)

    const list = client.getQueryData<ItemListResponse>(queryKeys.items.list({}, 1, 20))
    expect(list?.items[0].tags.care_instructions).toBe('Machine wash at 30°C, do not tumble dry.')
    // The other tags survive the patch.
    expect(list?.items[0].tags.colors).toEqual(['navy'])
  })

  it.each([
    [422, { detail: { error_code: 'CARE_LABEL_UNREADABLE', message: 'x' } }, careLabel.errors.unreadable],
    [502, { detail: { error_code: 'AI_UNREACHABLE', message: 'x' } }, careLabel.errors.aiUnreachable],
    [503, { detail: { error_code: 'AI_VISION_DISABLED', message: 'x' } }, careLabel.errors.visionDisabled],
    [404, { detail: 'Item not found' }, careLabel.errors.notFound],
    [413, { detail: 'File exceeds the 1 MB upload limit' }, careLabel.errors.tooLarge.replace('{limit}', '1')],
    [429, { detail: 'Too many requests' }, careLabel.errors.rateLimited],
    // A 422 without the code (the request itself was rejected) is not an unreadable label.
    [422, { detail: 'Validation error', errors: [] }, careLabel.errors.generic],
    [500, { detail: 'oops' }, careLabel.errors.generic],
  ])('maps a %i to its own message', async (status, body, message) => {
    respond(status, body)
    renderDialog()
    pickFile()

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message))
  })

  it('reports a network failure without a status', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    renderDialog()
    pickFile()

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(careLabel.errors.generic))
  })

  it('refuses a photo over the upload limit without sending it', () => {
    renderDialog()
    pickFile(new File([new Uint8Array(2 * 1024 * 1024)], 'big.jpg', { type: 'image/jpeg' }))

    expect(toast.error).toHaveBeenCalledWith(careLabel.errors.tooLarge.replace('{limit}', '1'))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hides the upload button when AI UI is off but still shows saved instructions', () => {
    renderDialog({ tags: { ...item.tags, care_instructions: 'Dry clean only.' } }, false)
    expect(screen.getByText('Dry clean only.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: careLabel.upload })).not.toBeInTheDocument()
  })
})
