/**
 * Allowlist EXPLÍCITA de operações contra a API do Mercado Livre.
 *
 * Regras (revisão da Etapa 2.1):
 * - O frontend NUNCA escolhe URLs — só nomeia uma operação desta lista.
 * - Cada operação valida seus parâmetros com zod e monta a URL no servidor.
 * - A resposta é filtrada: só os campos que o dashboard realmente usa.
 * - Nenhum header ou token da API do ML é repassado.
 * - Não existe operação genérica tipo /api/ml?url=... — proposital.
 *
 * Inventário de origem (index.html, chamadas mapeadas na auditoria):
 *   items-search, items, orders, orders (cancelled), order, order-discounts,
 *   shipment, reputation, visits, sites-search, product-items, promotions,
 *   promotion-items, ads-billing, promotion-item-set (POST),
 *   promotion-item-remove (DELETE).
 */
import { z } from 'zod';
import { getEnv } from '../config/env.js';
import { mlFetch } from '../lib/ml-auth.js';
import type { Cache } from '../lib/cache/cache.js';

// ── Helpers de filtragem ──────────────────────────────────────────────
type Obj = Record<string, unknown>;

function pick(obj: unknown, fields: string[]): Obj | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Obj;
  const out: Obj = {};
  for (const f of fields) if (f in o) out[f] = o[f];
  return out;
}

// Campos que o dashboard usa em cada entidade (auditoria seções/abas):
const ITEM_FIELDS = [
  'id', 'title', 'price', 'base_price', 'original_price', 'available_quantity',
  'sold_quantity', 'status', 'sub_status', 'permalink', 'thumbnail', 'category_id',
  'condition', 'last_updated', 'date_created', 'catalog_listing', 'catalog_product_id',
  'inventory_id', 'shipping', 'seller_custom_field', 'attributes', 'variations',
  'listing_type_id', 'health', 'tags',
];

const ORDER_SLIM_FIELDS = [
  'id', 'status', 'status_detail', 'date_created', 'date_closed', 'last_updated',
  'total_amount', 'paid_amount', 'currency_id', 'order_items', 'buyer', 'shipping',
  'tags', 'cancel_detail', 'fees',
];

const ORDER_DETAIL_FIELDS = [
  ...ORDER_SLIM_FIELDS,
  'payments', 'coupon', 'taxes', 'context', 'mediations', 'feedback', 'pack_id',
];

const SHIPMENT_FIELDS = [
  'id', 'status', 'substatus', 'status_history', 'tracking_number', 'tracking_method',
  'logistic_type', 'declared_value', 'base_cost', 'shipping_option', 'date_created',
  'last_updated', 'lead_time', 'receiver_address', 'origin', 'destination', 'tags',
];

const SEARCH_RESULT_FIELDS = [
  'id', 'title', 'price', 'original_price', 'sold_quantity', 'available_quantity',
  'permalink', 'thumbnail', 'seller', 'shipping', 'official_store_id',
  'listing_type_id', 'catalog_product_id', 'condition', 'attributes',
];

function slimBuyer(o: Obj | null): Obj | null {
  if (!o) return o;
  if (o.buyer) o.buyer = pick(o.buyer, ['id', 'nickname']); // sem nome/CPF/telefone
  return o;
}

// ── Definição das operações ───────────────────────────────────────────
const mlbId = z.string().regex(/^MLB\d{6,15}$/, 'id MLB inválido');
const digits = z.string().regex(/^\d{5,20}$/, 'id numérico inválido');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.+-]{8,24}Z?)?$/, 'data inválida');

export interface OpDef {
  method: 'GET' | 'POST' | 'DELETE';
  params: z.ZodTypeAny;
  /** Monta o path do ML a partir dos params validados. */
  path: (p: any, uid: string) => string;
  /** Corpo (só ops de escrita). */
  body?: (p: any) => Obj;
  /** Filtra a resposta do ML para o mínimo necessário. */
  shape: (data: any) => unknown;
}

export const OPS: Record<string, OpDef> = {
  // 1) IDs de anúncios por status (paginado) — loadAllItemIds
  'items-search': {
    method: 'GET',
    params: z.object({
      status: z.enum(['active', 'paused', 'closed']),
      offset: z.coerce.number().int().min(0).max(10000).default(0),
    }),
    path: (p, uid) => `/users/${uid}/items/search?status=${p.status}&limit=100&offset=${p.offset}`,
    shape: d => ({ results: d.results ?? [], paging: pick(d.paging, ['total', 'offset', 'limit']) }),
  },

  // 2) Detalhe de anúncios em lote — loadItemsInBatches
  items: {
    method: 'GET',
    params: z.object({
      ids: z.string().transform(s => s.split(',').map(x => x.trim()).filter(Boolean))
        .pipe(z.array(mlbId).min(1).max(20)),
    }),
    path: p => `/items?ids=${p.ids.join(',')}&attributes=${ITEM_FIELDS.join(',')}`,
    shape: (d: any[]) => (Array.isArray(d) ? d : []).map(r => ({
      code: r.code,
      body: r.code === 200 ? pick(r.body, ITEM_FIELDS) : null,
    })),
  },

  // 3) Pedidos (paginado; cobre recentes, cancelados e faixas de data p/ sazonalidade)
  orders: {
    method: 'GET',
    params: z.object({
      offset: z.coerce.number().int().min(0).max(10000).default(0),
      limit: z.coerce.number().int().min(1).max(50).default(50),
      status: z.enum(['cancelled']).optional(),
      date_from: isoDate.optional(),
      date_to: isoDate.optional(),
    }),
    path: (p, uid) => {
      let q = `/orders/search?seller=${uid}&sort=date_desc&limit=${p.limit}&offset=${p.offset}`;
      if (p.status) q += `&order.status=${p.status}`;
      if (p.date_from) q += `&order.date_created.from=${encodeURIComponent(p.date_from)}`;
      if (p.date_to) q += `&order.date_created.to=${encodeURIComponent(p.date_to)}`;
      return q;
    },
    shape: d => ({
      results: (d.results ?? []).map((o: Obj) => slimBuyer(pick(o, ORDER_SLIM_FIELDS))),
      paging: pick(d.paging, ['total', 'offset', 'limit']),
    }),
  },

  // 4) Detalhe de um pedido — enrichOrderDetail
  order: {
    method: 'GET',
    params: z.object({ id: digits }),
    path: p => `/orders/${p.id}`,
    shape: d => slimBuyer(pick(d, ORDER_DETAIL_FIELDS)),
  },

  // 5) Descontos de um pedido — enrichOrderDetail
  'order-discounts': {
    method: 'GET',
    params: z.object({ id: digits }),
    path: p => `/orders/${p.id}/discounts`,
    shape: d => pick(d, ['details', 'order_id']),
  },

  // 6) Envio — enrichOrderDetail / aba Entregas
  shipment: {
    method: 'GET',
    params: z.object({ id: digits }),
    path: p => `/shipments/${p.id}`,
    shape: d => pick(d, SHIPMENT_FIELDS),
  },

  // 7) Reputação — loadReputation (só o que o card usa)
  reputation: {
    method: 'GET',
    params: z.object({}),
    path: (_p, uid) => `/users/${uid}`,
    shape: d => pick(d, ['nickname', 'seller_reputation']),
  },

  // 8) Visitas — loadVisitas / gráficos (30 e N dias)
  visits: {
    method: 'GET',
    params: z.object({ last: z.coerce.number().int().min(1).max(150).default(30) }),
    path: (p, uid) => `/users/${uid}/items_visits/time_window?last=${p.last}&unit=day`,
    shape: d => ({ results: d.results ?? [], total_visits: d.total_visits }),
  },

  // 9) Busca pública MLB — posicionamento/radar (posBuscar)
  'sites-search': {
    method: 'GET',
    params: z.object({
      q: z.string().min(1).max(120),
      offset: z.coerce.number().int().min(0).max(1000).default(0),
      limit: z.coerce.number().int().min(1).max(50).default(50),
    }),
    path: p => `/sites/MLB/search?q=${encodeURIComponent(p.q)}&limit=${p.limit}&offset=${p.offset}`,
    shape: d => ({
      results: (d.results ?? []).map((r: Obj) => pick(r, SEARCH_RESULT_FIELDS)),
      paging: pick(d.paging, ['total', 'offset', 'limit']),
    }),
  },

  // 10) Anúncios de um produto de catálogo — radar (/products/:id/items)
  'product-items': {
    method: 'GET',
    params: z.object({ id: mlbId }),
    path: p => `/products/${p.id}/items`,
    shape: d => ({
      results: (d.results ?? []).map((r: Obj) =>
        pick(r, ['item_id', 'seller_id', 'price', 'original_price', 'shipping', 'listing_type_id', 'official_store_id', 'sold_quantity'])),
      paging: pick(d.paging, ['total']),
    }),
  },

  // 11) Promoções do vendedor — rlCarregar
  promotions: {
    method: 'GET',
    params: z.object({}),
    path: (_p, uid) => `/seller-promotions/users/${uid}?app_version=v2`,
    shape: d => ({ results: d.results ?? [], paging: pick(d.paging, ['total']) }),
  },

  // 12) Itens de uma promoção — rlCarregarItens
  'promotion-items': {
    method: 'GET',
    params: z.object({
      id: z.string().min(1).max(80),
      type: z.string().regex(/^[A-Z_]{3,40}$/),
    }),
    path: p => `/seller-promotions/promotions/${encodeURIComponent(p.id)}/items?app_version=v2&promotion_type=${p.type}`,
    shape: d => ({ results: d.results ?? [], paging: pick(d.paging, ['total']) }),
  },

  // 13) Custo de publicidade — loadAdCost (espelha a cascata de endpoints)
  'ads-billing': {
    method: 'GET',
    params: z.object({ date_from: isoDate, date_to: isoDate }),
    path: (p, uid) =>
      `/advertising/product_ads/billing/aggregate?date_from=${p.date_from}&date_to=${p.date_to}&user_id=${uid}`,
    shape: d => d, // agregado já é pequeno; sem campos sensíveis
  },

  // 14) ESCRITA: inscrever item em promoção — rlPost (payload validado estrito)
  'promotion-item-set': {
    method: 'POST',
    params: z.object({
      id: mlbId,
      deal_price: z.number().positive().max(100000),
      stock: z.number().int().min(1).max(10000),
      promotion_type: z.string().regex(/^[A-Z_]{3,40}$/),
      promotion_id: z.string().min(1).max(80),
      top_deal_price: z.number().positive().max(100000).optional(),
    }),
    path: p => `/seller-promotions/items/${p.id}?app_version=v2`,
    body: p => {
      const b: Obj = {
        deal_price: p.deal_price,
        stock: p.stock,
        promotion_type: p.promotion_type,
        promotion_id: p.promotion_id,
      };
      if (p.top_deal_price !== undefined) b.top_deal_price = p.top_deal_price;
      return b;
    },
    shape: d => d,
  },

  // 15) ESCRITA: remover item de promoção — rlDelete
  'promotion-item-remove': {
    method: 'DELETE',
    params: z.object({
      id: mlbId,
      promotion_type: z.string().regex(/^[A-Z_]{3,40}$/),
      promotion_id: z.string().min(1).max(80),
    }),
    path: p =>
      `/seller-promotions/items/${p.id}?app_version=v2&promotion_type=${p.promotion_type}&promotion_id=${encodeURIComponent(p.promotion_id)}`,
    shape: d => d,
  },
};

export interface OpResult {
  status: number;
  data: unknown;
}

/** Executa uma operação da allowlist. Erros do ML voltam sem headers/tokens. */
export async function runOp(cache: Cache, opName: string, rawParams: unknown): Promise<OpResult> {
  const op = OPS[opName];
  if (!op) return { status: 404, data: { error: `Operação desconhecida: ${opName}` } };

  const parsed = op.params.safeParse(rawParams);
  if (!parsed.success) {
    const detalhe = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { status: 400, data: { error: `Parâmetros inválidos — ${detalhe}` } };
  }

  const env = getEnv();
  const path = op.path(parsed.data, env.ML_USER_ID);

  const init: RequestInit = { method: op.method };
  if (op.body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(op.body(parsed.data));
  }

  const res = await mlFetch(cache, path, init);
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* respostas vazias (204 etc.) */
  }

  if (!res.ok) {
    // Repassa a causa (útil p/ aba Relâmpago) sem headers nem tokens.
    const err = (data ?? {}) as Obj;
    return {
      status: res.status,
      data: { error: `ML API ${res.status}`, message: err.message, cause: err.cause },
    };
  }

  return { status: 200, data: op.shape(data ?? {}) };
}
