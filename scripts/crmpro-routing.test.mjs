import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCrmProSubmitBody, sendCrmProLead } from '../lib/integrations/crmpro.ts'

const lead = { name: 'Routing unit test', phone: '01000000000', createdAt: '2026-09-22T00:00:00Z' }

test('ChatGPT paid routes to GPT intake while ordinary and other media stay unchanged', () => {
  process.env.CRM_PRO_GROUP_NO = '116'
  for (const [utmSource, utmMedium, group] of [
    ['chatgpt', 'paid', 196], [' ChatGPT ', ' PAID ', 196],
    ['chatgpt', 'organic', 116], ['chatgpt', null, 116],
    ['google', 'paid', 116], ['facebook', 'paid', 116], [null, null, 116],
  ]) {
    const body = buildCrmProSubmitBody({ ...lead, utmSource, utmMedium })
    assert.equal(body.group_no, group)
    assert.equal(body.tel, '01000000000')
  }
  assert.equal(buildCrmProSubmitBody({ ...lead, phone: '' }), null)
})

test('CRM request sends one lead to GPT intake without adding counselor overrides', async () => {
  const oldFetch = globalThis.fetch
  const oldKey = process.env.CRM_PRO_API_KEY
  const calls = []
  process.env.CRM_PRO_API_KEY = 'unit-test-only'
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }
  try {
    assert.equal(await sendCrmProLead({ ...lead, utmSource: 'chatgpt', utmMedium: 'paid' }), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].body.group_no, 196)
    assert.equal(calls[0].body.utm_source, 'chatgpt')
    assert.equal(calls[0].body.call_id, undefined)
  } finally {
    globalThis.fetch = oldFetch
    if (oldKey === undefined) delete process.env.CRM_PRO_API_KEY
    else process.env.CRM_PRO_API_KEY = oldKey
  }
})
