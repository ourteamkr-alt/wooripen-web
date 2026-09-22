// ─────────────────────────────────────────────
// CRMPro 리드 전송 (crmpro.kr)
//
// 배경 (2026-08-03) :
//   - 상담폼이 Supabase consultations 저장까지만 하고 CRM 미전송이던 문제(#2) 해결
//   - 오즈랩페이(ozlab)에서 검증된 동일 API 스키마를 이식 — 수신 그룹만 다름
//     · 우리편: group_no 116 (116.인바운드_우리편)
//
// env (서버 전용 — NEXT_PUBLIC_ 접두사 절대 금지):
//   - CRM_PRO_API_KEY    필수. 미설정 시 전송 스킵(no-op) + 경고 로그
//   - CRM_PRO_GROUP_NO   기본 유입 참고값. GPT 유료 유입 외에는 116 유지
//   - CRM_PRO_BASE_URL   선택. 기본 https://crmpro.kr/api
//
// 동작 원칙 :
//   - CRM 전송 실패해도 상담 접수(Supabase 저장) 자체는 막지 않음
//   - Vercel 서버리스는 응답 후 백그라운드 작업이 중단되므로
//     fire-and-forget 금지 — 반드시 await (타임아웃 5초로 상한)
// ─────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://crmpro.kr/api'
const FINAL_CRM_PRO_GROUP_NO = 116 // 116.인바운드_우리편
const CHATGPT_ADS_GROUP_NO = 196 // GPT광고_토스 유입 → 바인컴즈_토스 배정

// 폼 product_category 슬러그 → CRM 표기용 한글 라벨
const CATEGORY_LABELS: Record<string, string> = {
  internet: '인터넷',
  terminal: '결제단말기',
  cctv: 'CCTV',
  kiosk: '키오스크',
  torder: '티오더',
  rental: '렌탈',
  package: '패키지',
  general: '일반 상담',
}

export interface CrmProLeadPayload {
  name: string
  phone: string
  productCategory?: string | null
  interestedProducts?: string[] | null
  businessType?: string | null      // 업종 (recommend 폼만 수집, 나머지 폼엔 없음)
  businessAddress?: string | null   // 매장명/주소
  message?: string | null
  createdAt?: string | Date | null
  clientIp?: string | null
  landingPagePath?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
}

interface CrmProSubmitBody {
  group_no: number
  name: string
  tel: string
  etc1: string // 업종
  etc2: string // 희망 상품/서비스
  etc3: string // 통화가능시간
  etc4: string // 메모
  etc5: string // 추가정보 (매장·랜딩·UTM 요약)
  reg_datetime: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
}

export function buildCrmProSubmitBody(p: CrmProLeadPayload): CrmProSubmitBody | null {
  const tel = p.phone.replace(/\D/g, '')
  if (!p.name || tel.length < 9) return null

  const categoryLabel = p.productCategory
    ? CATEGORY_LABELS[p.productCategory] ?? p.productCategory
    : null
  const interested = (p.interestedProducts ?? []).filter(Boolean).join(', ')
  const desiredService =
    firstText(interested, categoryLabel) ?? '우리편 상담'

  const extraInfo = [
    p.businessAddress ? `매장: ${p.businessAddress}` : null,
    p.landingPagePath ? `랜딩: ${p.landingPagePath}` : null,
    p.utmSource ? `utm_source: ${p.utmSource}` : null,
    p.utmMedium ? `utm_medium: ${p.utmMedium}` : null,
    p.utmCampaign ? `utm_campaign: ${p.utmCampaign}` : null,
  ].filter(Boolean).join(' / ')

  const utmSource = firstText(p.utmSource)
  const utmMedium = firstText(p.utmMedium)
  const utmCampaign = firstText(p.utmCampaign)

  return {
    group_no: resolveCrmProGroupNo(p),
    name: p.name,
    tel,
    // 업종은 recommend 폼만 수집 — 없으면 상품 카테고리로 대체 (엄군 정책 확정 전 임시)
    etc1: firstText(p.businessType, categoryLabel) ?? '미입력',
    etc2: desiredService,
    // 통화가능시간 필드는 폼에 없음 — 정책 확정 전 '미정' 고정 (ozlab 과 동일 규칙)
    etc3: '미정',
    etc4: (firstText(p.message) ?? '미입력').slice(0, 500),
    etc5: extraInfo.slice(0, 500),
    reg_datetime: formatKstDatetime(p.createdAt ?? new Date()),
    ...(utmSource ? { utm_source: utmSource } : {}),
    ...(utmMedium ? { utm_medium: utmMedium } : {}),
    ...(utmCampaign ? { utm_campaign: utmCampaign } : {}),
  }
}

export async function sendCrmProLead(p: CrmProLeadPayload): Promise<boolean> {
  const apiKey = process.env.CRM_PRO_API_KEY
  if (!apiKey) {
    console.warn('[CRMPro] skipped: CRM_PRO_API_KEY is not configured')
    return false
  }

  const body = buildCrmProSubmitBody(p)
  if (!body) {
    console.warn('[CRMPro] skipped: invalid lead payload')
    return false
  }

  const baseUrl = (process.env.CRM_PRO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  }
  if (p.clientIp) headers['X-Forwarded-For'] = p.clientIp

  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const ctrl = new AbortController()
    timer = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(`${baseUrl}/db/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })

    if (!res.ok) {
      // 응답 본문에 제출값(이름·전화)이 에코될 수 있으므로 길이를 자르고 키를 가린다
      const text = await res.text().catch(() => '')
      console.warn('[CRMPro] non-2xx', res.status, safeLog(text))
      return false
    }

    const result = await res.json().catch(() => null) as { success?: boolean; message?: string } | null
    if (result && result.success === false) {
      console.warn('[CRMPro] rejected', safeLog(result.message ?? 'unknown'))
      return false
    }
    console.info('[CRMPro] submitted', {
      group_no: body.group_no,
      has_utm_source: Boolean(body.utm_source),
      message: safeLog(result?.message ?? 'ok'),
    })
    return true
  } catch (err) {
    // undici 는 헤더 검증 실패 시 문제가 된 값(=API 키)을 메시지에 담을 수 있다 → 반드시 redact
    console.warn('[CRMPro] fetch error', safeLog(err instanceof Error ? err.message : String(err)))
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function resolveCrmProGroupNo(p: CrmProLeadPayload): number {
  // GPT 자연 유입과 타 매체는 기존 그룹 유지. 클라이언트가 그룹 ID를 지정하지 못한다.
  const source = firstText(p.utmSource)?.toLowerCase()
  const medium = firstText(p.utmMedium)?.toLowerCase()
  if (source === 'chatgpt' && medium === 'paid') return CHATGPT_ADS_GROUP_NO

  const configured = Number(process.env.CRM_PRO_GROUP_NO)
  if (configured !== FINAL_CRM_PRO_GROUP_NO) {
    console.warn('[CRMPro] CRM_PRO_GROUP_NO mismatch; forcing final group', {
      configured_group_no: Number.isFinite(configured) ? configured : null,
      forced_group_no: FINAL_CRM_PRO_GROUP_NO,
    })
  }
  return FINAL_CRM_PRO_GROUP_NO
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const t = value.trim()
    if (t.length > 0) return t.slice(0, 200)
  }
  return null
}

function formatKstDatetime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(Number.isNaN(date.getTime()) ? new Date() : date)

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}:${byType.second}`
}

// 로그 안전 처리 — API 키 마스킹 + 길이 상한(응답에 제출값이 에코되는 경우 대비)
function safeLog(value: string): string {
  const key = process.env.CRM_PRO_API_KEY
  const masked = key ? value.replaceAll(key, '[redacted]') : value
  return masked.length > 300 ? `${masked.slice(0, 300)}…(truncated)` : masked
}
