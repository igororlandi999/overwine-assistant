/**
 * Leituras da API v3 do Bling: depósitos, produtos, estruturas (kits) e saldos.
 *
 * Os tipos espelham a referência OpenAPI oficial. Os campos são devolvidos
 * COMO O BLING OS ENTREGA, sem interpretação: este módulo não calcula estoque
 * disponível. Em particular:
 *
 *  - `saldoVirtual*` NÃO é estoque disponível por definição. A própria
 *    documentação descreve o campo de formas diferentes ("desconsiderando
 *    produtos reservados" em /estoques/saldos; "considerando a reserva" em
 *    /produtos/{id}). A semântica será validada com a conta real antes de
 *    qualquer uso em indicador.
 *  - `saldoMultiempresa` refere-se ao depósito virtual multiempresa e não
 *    pode ser somado ao saldo dos depósitos físicos.
 *  - Depósitos com `desconsiderarSaldo = true` existem na resposta; quem
 *    decide se entram em algum total é a camada de mapeamento (PR seguinte).
 *
 * Cada resposta passa por um esquema mínimo: se o Bling mudar o formato de um
 * campo usado aqui, a leitura falha com erro claro em vez de produzir número
 * errado em silêncio. Campos extras são preservados.
 */
import { z } from 'zod';
import type { Cache } from '../lib/cache/cache.js';
import { blingGet } from './cliente.js';
import type { DepsBling } from './auth.js';
import { LIMITE_PAGINA, MAX_IDS_SALDO } from './contrato.js';
import { BlingHttpError } from './erros.js';
import { digitosCnpj } from './config.js';
import type { EmpresaBling } from './auth.js';

const id = z.number().int().positive();
const num = z.number();

export const DepositoSchema = z.object({
  id,
  descricao: z.string(),
  situacao: z.number().int(), // 0 inativo, 1 ativo
  padrao: z.boolean(),
  desconsiderarSaldo: z.boolean(),
}).passthrough();
export type Deposito = z.infer<typeof DepositoSchema>;

export const SaldoDepositoSchema = z.object({
  id,
  saldoFisico: num,
  saldoVirtual: num,
  saldoMultiempresa: num.optional(),
}).passthrough();

export const SaldoProdutoSchema = z.object({
  produto: z.object({ id, codigo: z.string().nullable().optional() }).passthrough(),
  saldoFisicoTotal: num,
  saldoVirtualTotal: num,
  saldoMultiempresa: num.optional(),
  depositos: z.array(SaldoDepositoSchema).default([]),
}).passthrough();
export type SaldoProduto = z.infer<typeof SaldoProdutoSchema>;

export const ProdutoResumoSchema = z.object({
  id,
  idProdutoPai: z.number().int().nullable().optional(),
  nome: z.string(),
  codigo: z.string().nullable().optional(),
  preco: num.optional(),
  precoCusto: num.optional(),
  estoque: z.object({ saldoVirtualTotal: num.optional() }).passthrough().optional(),
  tipo: z.string(), // P produto, S serviço, ...
  situacao: z.string(), // A ativo, I inativo
  formato: z.string(), // S simples, V com variações, E com composição
}).passthrough();
export type ProdutoResumo = z.infer<typeof ProdutoResumoSchema>;

export const ComponenteSchema = z.object({
  produto: z.object({ id }).passthrough(),
  quantidade: num,
}).passthrough();

export const EstruturaSchema = z.object({
  tipoEstoque: z.string().optional(), // F físico, V virtual
  lancamentoEstoque: z.string().optional(), // A, M, P
  componentes: z.array(ComponenteSchema).default([]),
}).passthrough();
export type Estrutura = z.infer<typeof EstruturaSchema>;

export const ProdutoSchema = ProdutoResumoSchema.extend({
  gtin: z.string().nullable().optional(),
  estoque: z.object({
    minimo: num.optional(),
    maximo: num.optional(),
    crossdocking: num.optional(),
    localizacao: z.string().nullable().optional(),
    saldoVirtualTotal: num.optional(),
  }).passthrough().optional(),
  estrutura: EstruturaSchema.optional(),
}).passthrough();
export type Produto = z.infer<typeof ProdutoSchema>;

const envelope = <T extends z.ZodTypeAny>(item: T) => z.object({ data: item });
const lista = <T extends z.ZodTypeAny>(item: T) => z.object({ data: z.array(item) });

function validar<T extends z.ZodTypeAny>(schema: T, corpo: unknown, onde: string): z.infer<T> {
  const r = schema.safeParse(corpo);
  if (!r.success) {
    const campo = r.error.issues[0]?.path.join('.') || '(raiz)';
    throw new BlingHttpError(`resposta do Bling fora do contrato em ${onde} (campo ${campo})`, 200, 'contrato');
  }
  return r.data;
}

function idValido(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

function exigirId(n: unknown, nome: string): number {
  if (!idValido(n)) throw new BlingHttpError(`${nome} inválido`, 0);
  return n;
}

/** 404 vira null (registro não existe); o resto propaga. */
async function ouNulo<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; } catch (e) {
    if (e instanceof BlingHttpError && e.status === 404) return null;
    throw e;
  }
}

/** Teto de páginas por listagem completa: protege a cota contra laço sem fim. */
export const MAX_PAGINAS_DEPOSITOS = 10;

/** Todos os depósitos (paginado). Inclui inativos e os que desconsideram saldo. */
export async function listarDepositos(cache: Cache, deps: DepsBling = {}): Promise<Deposito[]> {
  const out: Deposito[] = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS_DEPOSITOS; pagina++) {
    const corpo = await blingGet(cache, '/depositos', { pagina, limite: LIMITE_PAGINA }, deps);
    const { data } = validar(lista(DepositoSchema), corpo, '/depositos');
    out.push(...data);
    if (data.length < LIMITE_PAGINA) return out;
  }
  throw new BlingHttpError(`mais de ${MAX_PAGINAS_DEPOSITOS} páginas de depósitos; leitura interrompida`, 0, 'paginacao');
}

export async function obterDeposito(cache: Cache, idDeposito: number, deps: DepsBling = {}): Promise<Deposito | null> {
  const i = exigirId(idDeposito, 'idDeposito');
  return ouNulo(blingGet(cache, `/depositos/${i}`, {}, deps)
    .then(c => validar(envelope(DepositoSchema), c, '/depositos/{id}').data));
}

export interface FiltroProdutos {
  pagina?: number;
  limite?: number;
  /** 1 últimos incluídos, 2 ativos, 3 inativos, 4 excluídos, 5 todos. */
  criterio?: 1 | 2 | 3 | 4 | 5;
  tipo?: 'T' | 'P' | 'S' | 'E' | 'PS' | 'C' | 'V';
  idsProdutos?: number[];
  codigos?: string[];
}

/** Uma página de produtos. Quem pagina é o chamador (sincronização, PR seguinte). */
export async function listarProdutos(cache: Cache, f: FiltroProdutos = {}, deps: DepsBling = {}): Promise<ProdutoResumo[]> {
  const limite = f.limite ?? LIMITE_PAGINA;
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_PAGINA) throw new BlingHttpError('limite inválido', 0);
  const corpo = await blingGet(cache, '/produtos', {
    pagina: f.pagina ?? 1,
    limite,
    criterio: f.criterio,
    tipo: f.tipo,
    'idsProdutos[]': f.idsProdutos?.map(n => exigirId(n, 'idsProdutos')),
    'codigos[]': f.codigos,
  }, deps);
  return validar(lista(ProdutoResumoSchema), corpo, '/produtos').data;
}

/** Produto completo, com GTIN e estrutura (quando é kit). */
export async function obterProduto(cache: Cache, idProduto: number, deps: DepsBling = {}): Promise<Produto | null> {
  const i = exigirId(idProduto, 'idProduto');
  return ouNulo(blingGet(cache, `/produtos/${i}`, {}, deps)
    .then(c => validar(envelope(ProdutoSchema), c, '/produtos/{id}').data));
}

/** Estrutura (composição) de um produto do tipo kit. */
export async function obterEstrutura(cache: Cache, idProdutoEstrutura: number, deps: DepsBling = {}): Promise<Estrutura | null> {
  const i = exigirId(idProdutoEstrutura, 'idProdutoEstrutura');
  return ouNulo(blingGet(cache, `/produtos/estruturas/${i}`, {}, deps)
    .then(c => validar(envelope(EstruturaSchema), c, '/produtos/estruturas/{id}').data));
}

/**
 * Saldos por produto, em lotes de até 100 ids (limite documentado). Com
 * `idDeposito`, usa /estoques/saldos/{idDeposito} (saldos de um depósito só).
 * Ids repetidos são enviados uma única vez.
 */
export async function lerSaldos(
  cache: Cache, entrada: { idsProdutos: number[]; idDeposito?: number }, deps: DepsBling = {},
): Promise<SaldoProduto[]> {
  const ids = [...new Set(entrada.idsProdutos.map(n => exigirId(n, 'idsProdutos')))];
  const caminho = entrada.idDeposito === undefined
    ? '/estoques/saldos'
    : `/estoques/saldos/${exigirId(entrada.idDeposito, 'idDeposito')}`;
  const out: SaldoProduto[] = [];
  for (let i = 0; i < ids.length; i += MAX_IDS_SALDO) {
    const lote = ids.slice(i, i + MAX_IDS_SALDO);
    const corpo = await blingGet(cache, caminho, { 'idsProdutos[]': lote }, deps);
    out.push(...validar(lista(SaldoProdutoSchema), corpo, caminho).data);
  }
  return out;
}

/** Campos de depósito que podem sair do backend (rota administrativa). */
export type DepositoResumo = Pick<Deposito, 'id' | 'descricao' | 'situacao' | 'padrao' | 'desconsiderarSaldo'>;

/** Depósitos reduzidos EXATAMENTE aos cinco campos permitidos (nada de passthrough). */
export async function listarDepositosResumo(cache: Cache, deps: DepsBling = {}): Promise<DepositoResumo[]> {
  return (await listarDepositos(cache, deps)).map(d => ({
    id: d.id, descricao: d.descricao, situacao: d.situacao, padrao: d.padrao, desconsiderarSaldo: d.desconsiderarSaldo,
  }));
}

export const EmpresaSchema = z.object({
  id: z.string().min(1),
  nome: z.string(),
  cnpj: z.string(),
}).passthrough();

/**
 * Empresa dona do token (GET /empresas/me/dados-basicos, escopo "Empresas").
 * Recebe o access token EXPLÍCITO de uma autorização recém-concluída: a
 * empresa precisa ser conhecida ANTES de os tokens poderem virar cadeia
 * ativa. Devolve só id, nome e CNPJ em dígitos (o e-mail é descartado).
 */
export async function obterEmpresaDoToken(cache: Cache, accessToken: string, deps: DepsBling = {}): Promise<EmpresaBling> {
  const corpo = await blingGet(cache, '/empresas/me/dados-basicos', {}, deps, { tokenFixo: accessToken });
  const { data } = validar(envelope(EmpresaSchema), corpo, '/empresas/me/dados-basicos');
  const cnpj = digitosCnpj(data.cnpj);
  if (cnpj.length !== 14) throw new BlingHttpError('resposta do Bling fora do contrato em /empresas/me/dados-basicos (campo data.cnpj)', 200, 'contrato');
  return { id: data.id, nome: data.nome.slice(0, 200), cnpj };
}
