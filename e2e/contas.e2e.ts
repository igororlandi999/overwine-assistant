/**
 * Roteiro de navegador dos seletores de empresa e marketplace.
 *
 * Dashboard REAL no Chromium + handlers REAIS do backend + Mercado Livre
 * SIMULADO com dois vendedores (ver ambiente.ts). Nenhum dado real.
 *
 * Valida os seis pontos da entrega:
 *  1. Overwine mantem o comportamento atual (nenhum parametro novo na rede).
 *  2. Degustar mostra os pedidos dela.
 *  3. Nenhum pedido aparece na conta errada.
 *  4. Consolidado corresponde as duas bases, com indicadores recalculados.
 *  5. Trocar conta e periodo rapidamente nao mistura dados.
 *  6. A atualizacao automatica continua funcionando por conta.
 * e o financeiro: tarifa e frete REAIS com cobertura, sem percentual da Overwine.
 *
 * Rodar: ver e2e/README.md. Leva cerca de 2 minutos — o cooldown do refresh e real.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest } from '../src/lib/orders-store.js';
import {
  iniciarAmbiente, esperado as esperadoDe, pedidoML, ehOW, ehDG,
  OW, DG, TOK_OW, TOK_DG, SENHA, DG_TARIFA, DG_FRETE, type Ambiente,
} from './ambiente.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
function carregarPlaywright() {
  const tentativas = [process.env.PLAYWRIGHT_DIR, 'playwright'].filter(Boolean) as string[];
  for (const t of tentativas) { try { return require(t); } catch { /* proxima */ } }
  throw new Error('Playwright nao encontrado. Rode `npm install` e `npx playwright install chromium` em e2e/, ou defina PLAYWRIGHT_DIR.');
}
const { chromium } = carregarPlaywright();
const SAIDA = process.env.E2E_SAIDA || resolve(AQUI, 'saida');
mkdirSync(SAIDA, { recursive: true });

const PORT = Number(process.env.E2E_PORTA || 5517);
let amb: Ambiente;
let ORIGIN = '';
let httpLog: Ambiente['httpLog'] = [];
let mlLog: Ambiente['mlLog'] = [];
let lojas: Ambiente['lojas'] = {};
let cache: Ambiente['cache'];
let cacheDG: Ambiente['cacheDG'];
let fetchReal: typeof fetch;
const TEST_ENV = { DASHBOARD_PASSWORD: SENHA };

beforeAll(async () => {
  amb = await iniciarAmbiente({ porta: PORT, silencioso: true });
  ({ httpLog, mlLog, lojas, cache, cacheDG, fetchReal } = amb);
  ORIGIN = amb.origem;
}, 60_000);
afterAll(async () => { await amb?.encerrar(); });

const esperado = (toks: string[], from: string, to: string) => esperadoDe(lojas, toks, from, to);
const numero = (txt: string | null) => Number(String(txt || '').replace(/[^\d,]/g, '').replace(',', '.'));
const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

describe('E2E — seletores de empresa e marketplace no navegador', () => {
  it('Overwine, Degustar e consolidado: isolamento, recalculo, troca rapida e atualizacao por conta', async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await ctx.newPage();
    const erros: string[] = [];
    page.on('pageerror', (e: any) => erros.push('pageerror: ' + e.message));
    page.on('console', (m: any) => { if (m.type() === 'error') erros.push('console: ' + m.text()); });
    const relato: string[] = [];
    const ok = (c: boolean, t: string) => { relato.push((c ? 'ok   ' : 'ERRO ') + t); expect(c, t).toBe(true); };

    const pronto = async () => {
      await page.waitForSelector('#main-header', { state: 'visible', timeout: 60_000 });
      await page.waitForFunction('typeof _loadAllEmCurso !== "undefined" && !_loadAllEmCurso && _metrics !== null', null, { timeout: 60_000 });
    };
    const abrirPedidos = async () => {
      await page.evaluate(`switchSection('visaogeral'); switchTab('pedidos')`);
      await page.waitForFunction('pedidosEmMemoria()', null, { timeout: 60_000 });
      await page.waitForTimeout(400);
    };
    const pedidosNaTela = async (): Promise<{ id: number; conta: string | null; status: string | null }[]> =>
      page.evaluate(`allOrders.map(o => ({ id: Number(o.id), conta: o.conta || null, status: o.status }))`);
    const linhasDaTabela = async (): Promise<{ id: number; conta: string | null; tag: string | null }[]> =>
      page.evaluate(`[...document.querySelectorAll('#pedidos-table tr')].filter(tr => tr.querySelector('.item-sku')).map(tr => ({
        id: Number(tr.querySelector('.item-sku').textContent.replace('#', '')),
        conta: tr.getAttribute('data-conta'),
        tag: tr.querySelector('.tag-conta') ? tr.querySelector('.tag-conta').textContent : null }))`);
    const trocar = async (empresa: string) => {
      const marca = httpLog.length;
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 60_000 }),
        page.selectOption('#conta-empresa', empresa),
      ]);
      await pronto();
      return marca;
    };
    const periodo = async () => page.evaluate('({ from: gdrGet().from, to: gdrGet().toEfetivo, label: gdrGet().label, preset: globalDateRange.preset })') as Promise<{ from: string; to: string; label: string; preset: string }>;
    const dadosDe = (marca: number) => httpLog.slice(marca).filter(l => /^\/api\/(orders|items|ml)\//.test(l.path) && l.path !== '/api/orders/contas');

    // ═══ 1. OVERWINE — comportamento de sempre ═══════════════════════════════
    await page.goto(ORIGIN + '/');
    await page.fill('#viewer-pass', TEST_ENV.DASHBOARD_PASSWORD);
    await page.press('#viewer-pass', 'Enter');
    await pronto();
    relato.push('═══ 1. Overwine sozinha');
    ok(await page.evaluate('selecaoChave()') === OW, 'selecao inicial e overwine-ml');
    ok(await page.evaluate(`document.getElementById('conta-sel').classList.contains('visivel')`), 'seletores visiveis (duas contas conectadas)');
    const opE = await page.evaluate(`[...document.getElementById('conta-empresa').options].map(o => o.value + '=' + o.textContent)`);
    const opC = await page.evaluate(`[...document.getElementById('conta-canal').options].map(o => o.value + '=' + o.textContent + (o.disabled ? ' [desabilitado]' : ''))`);
    relato.push('     empresas: ' + opE.join(' | '));
    relato.push('     marketplaces: ' + opC.join(' | '));
    ok(await page.inputValue('#conta-empresa') === 'alemmar' && await page.inputValue('#conta-canal') === 'ml', 'Empresa=Overwine, Marketplace=Mercado Livre');
    await abrirPedidos();
    await page.waitForTimeout(1500);   // secundarios (visitas, reputacao, publicidade)
    const redeOW = dadosDe(0);
    const comParam = redeOW.filter(l => /[?&]contas?=/.test(l.query));
    ok(comParam.length === 0, `nenhuma das ${redeOW.length} requisicoes de dados levou conta/contas (rede identica a de antes)`);
    const p1 = await periodo();
    const e1 = esperado([TOK_OW], p1.from, p1.to);
    let ped = await pedidosNaTela();
    ok(ped.length === 120 && ped.every(p => ehOW(p.id)), `historico: ${ped.length} pedidos, todos da Overwine`);
    ok(ped.every(p => p.conta === null), 'pedidos da Overwine sem marca de conta (formato de sempre)');
    let lin = await linhasDaTabela();
    ok(lin.length > 0 && lin.every(l => ehOW(l.id) && l.conta === null && l.tag === null), `tabela: ${lin.length} linhas, so Overwine, sem atributo nem etiqueta`);
    const brutoOW = await page.evaluate('_metrics.periodo.faturamento.bruto');
    const liqOW = await page.evaluate('_metrics.periodo.faturamento.liquido');
    ok(brutoOW === e1.bruto, `bruto do periodo (${p1.label}) = ${brutoOW} = soma dos ${e1.pedidos} pedidos da Overwine`);
    ok(Math.abs(liqOW - e1.bruto * (1 - 0.148 - 0.144)) < 0.01, `liquido estimado com as tarifas da Overwine = ${liqOW.toFixed(2)}`);
    await page.evaluate(`switchTab('visaogeral')`);
    await page.waitForTimeout(300);
    ok(numero(await page.textContent('#kpi-faturamento')) === e1.bruto, 'card Faturamento = ' + (await page.textContent('#kpi-faturamento')));
    ok(!/indispon/i.test(await page.textContent('#kpi-liq') || ''), 'card Liquido com valor: ' + (await page.textContent('#kpi-liq')));
    ok((await page.textContent('#main-header .logo') || '').includes('Overwine'), 'titulo: ' + (await page.textContent('#main-header .logo')));
    // publicidade manual e meta da Overwine — nao podem aparecer depois na Degustar
    await page.fill('#kpi-pub-input', '555');
    await page.evaluate('saveKpiPubManual()');
    await page.evaluate(`switchSection('financeiro'); switchTab('previsao')`);
    await page.waitForTimeout(500);
    ok(await page.inputValue('#pv-meta') === '80000', 'Previsao: meta padrao da Overwine 80000');
    await page.evaluate(`switchTab('margem')`);
    await page.waitForFunction(`!/Calculando/.test(document.getElementById('mg-table').textContent)`, null, { timeout: 30_000 });
    const mgOW = await page.textContent('#mg-margem');
    ok(!/indispon/i.test(mgOW || '') && numero(mgOW) > 0, 'Margem Real da Overwine calculada: ' + mgOW);
    await page.screenshot({ path: SAIDA + '/1-overwine-margem.png' });
    await page.evaluate(`switchSection('visaogeral'); switchTab('pedidos')`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: SAIDA + '/1-overwine-pedidos.png' });

    // ═══ 2. DEGUSTAR — so os pedidos dela ════════════════════════════════════
    relato.push('═══ 2. Degustar sozinha');
    let marca = await trocar('degustar');
    ok(await page.evaluate('selecaoChave()') === DG, 'selecao = degustar-ml apos a troca');
    ok(await page.evaluate(`document.querySelector('.tab-content.active').id`) === 'tab-pedidos', 'a aba aberta (Pedidos) atravessou a troca');
    const p2 = await periodo();
    ok(p2.preset === p1.preset && p2.from === p1.from, 'o periodo atravessou a troca: ' + p2.label);
    await abrirPedidos();
    await page.waitForTimeout(1500);
    const e2 = esperado([TOK_DG], p2.from, p2.to);
    ped = await pedidosNaTela();
    ok(ped.length === 21 && ped.every(p => ehDG(p.id)), `historico: ${ped.length} pedidos, todos da Degustar`);
    ok(ped.every(p => p.conta === DG), 'todos marcados conta=degustar-ml');
    lin = await linhasDaTabela();
    ok(lin.length > 0 && lin.every(l => ehDG(l.id) && l.conta === DG), `tabela: ${lin.length} linhas, so Degustar`);
    const redeDG = dadosDe(marca);
    const errados = redeDG.filter(l => l.path === '/api/orders/refresh' ? JSON.parse(l.req || '{}').conta !== DG : !/[?&]contas?=degustar-ml(&|$)/.test(l.query));
    ok(errados.length === 0, `todas as ${redeDG.length} requisicoes de dados levaram a conta degustar-ml` + (errados.length ? ' — sem: ' + errados.map(l => l.path + l.query).join(', ') : ''));
    const brutoDG = await page.evaluate('_metrics.periodo.faturamento.bruto');
    ok(brutoDG === e2.bruto, `bruto do periodo = ${brutoDG} = soma dos ${e2.pedidos} pedidos da Degustar`);
    // Financeiro no MES: so os 12 pedidos mais novos da Degustar tem tarifa e frete (os
    // demais foram "carregados antes do campo"). Cobertura parcial => total ausente.
    const finDG: any = await page.evaluate('({ f: _metrics.periodo.faturamento, k: _metrics.financeiro.conhecido, c: _metrics.financeiro.porConta["degustar-ml"] })');
    ok(finDG.f.liquido === null && finDG.f.tarifaML === null, 'mes atual: liquido e tarifa do periodo vieram null (cobertura parcial)');
    ok(finDG.c.metodo === 'apurado_pedidos_envios', 'metodo da Degustar: apurado nos pedidos e envios');
    ok(finDG.k.completo === false && finDG.k.liquido.receitaCoberta === e2.receitaComTarifa, `subtotal conhecido cobre ${finDG.k.liquido.receitaCoberta} de ${e2.bruto} (${e2.comTarifa} de ${e2.pedidos} pedidos)`);
    ok(Math.abs(finDG.k.liquido.valor - e2.comTarifa * (100 - DG_TARIFA - DG_FRETE)) < 0.001, `subtotal liquido = ${finDG.k.liquido.valor} = ${e2.comTarifa} x (100 - ${DG_TARIFA} - ${DG_FRETE})`);
    await page.evaluate(`switchTab('visaogeral')`);
    await page.waitForTimeout(300);
    ok(numero(await page.textContent('#kpi-faturamento')) === e2.bruto, 'card Faturamento = ' + (await page.textContent('#kpi-faturamento')));
    for (const id of ['kpi-liq', 'kpi-tarifa-ml', 'kpi-tarifa-env']) {
      const t = await page.textContent('#' + id);
      const sub = await page.textContent('#' + id + '-pct');
      ok(/indispon/i.test(t || '') && !/R\$/.test(t || ''), `card ${id}: "${t}" — total ausente`);
      ok(/^subtotal conhecido: R\$/.test(sub || '') && /cobre \d+% da receita/.test(sub || ''), `card ${id}: "${sub}"`);
      ok(await page.getAttribute('#' + id, 'data-cobertura') === 'parcial', `card ${id}: marcado como cobertura parcial`);
    }
    await page.screenshot({ path: SAIDA + '/2-degustar-cobertura-parcial.png' });
    // Periodo em que TODOS os pedidos tem tarifa e frete: total REAL, sem percentual.
    const de10 = ymd(new Date(Date.now() - 10 * 86400_000)), ate10 = ymd(new Date());
    await page.selectOption('#gdr-preset', 'custom');
    await page.fill('#gdr-de', de10);
    await page.fill('#gdr-ate', ate10);
    await page.click('#gdr-apply');
    await page.waitForFunction('!document.getElementById("gdr-preset").disabled && _metrics && _metrics.periodo.fromYmd === "' + de10 + '"', null, { timeout: 60_000 });
    await page.waitForTimeout(500);
    const e2c = esperado([TOK_DG], de10, ate10);
    const realDG: any = await page.evaluate('_metrics.periodo.faturamento');
    ok(e2c.pedidos > 0 && e2c.comTarifa === e2c.pedidos, `ultimos 10 dias: ${e2c.pedidos} pedidos, todos com tarifa e frete`);
    ok(Math.abs(realDG.tarifaML + e2c.pedidos * DG_TARIFA) < 0.001 && Math.abs(realDG.tarifaEnv + e2c.pedidos * DG_FRETE) < 0.001, `tarifa REAL ${realDG.tarifaML} e frete REAL ${realDG.tarifaEnv} (${e2c.pedidos} x ${DG_TARIFA} e x ${DG_FRETE})`);
    ok(Math.abs(realDG.liquido - (e2c.bruto - e2c.pedidos * (DG_TARIFA + DG_FRETE))) < 0.001 && realDG.estimado === false, `liquido REAL = ${realDG.liquido}, nao estimado`);
    ok(Math.abs(realDG.tarifaML + e2c.bruto * 0.148) > 1, 'a tarifa NAO e 14,8% do bruto (percentual da Overwine)');
    ok(numero(await page.textContent('#kpi-liq')) === Math.round(realDG.liquido), 'card Liquido = ' + (await page.textContent('#kpi-liq')) + ' · ' + (await page.textContent('#kpi-liq-pct')));
    ok(/valor real/.test(await page.textContent('#kpi-liq-pct') || ''), 'o card diz que o valor e real');
    await page.screenshot({ path: SAIDA + '/2-degustar-cobertura-completa.png' });
    await page.selectOption('#gdr-preset', 'mes_atual');
    await page.waitForFunction('!document.getElementById("gdr-preset").disabled && _metrics && _metrics.periodo.fromYmd === "' + p2.from + '"', null, { timeout: 60_000 });
    await page.waitForTimeout(500);
    ok(await page.inputValue('#kpi-pub-input') === '', 'publicidade manual da Overwine (555) NAO aparece na Degustar');
    ok(await page.evaluate('kpiPubManual') === 0 && await page.evaluate('ADS_DATA.totalInvestimento') === 0, 'sem publicidade herdada (manual=0, relatorio embutido=0)');
    ok((await page.textContent('#main-header .logo') || '').includes('Degustar'), 'titulo: ' + (await page.textContent('#main-header .logo')));
    await page.screenshot({ path: SAIDA + '/2-degustar-geral.png' });
    const repDG = await page.textContent('#card-reputacao');
    ok(/Verde Claro/.test(repDG || ''), 'reputacao e a da Degustar (Verde Claro), nao a da Overwine (Verde)');
    await page.evaluate(`switchSection('financeiro'); switchTab('margem')`);
    await page.waitForFunction(`!/Calculando/.test(document.getElementById('mg-table').textContent)`, null, { timeout: 30_000 });
    ok(/indispon/i.test(await page.textContent('#mg-margem') || ''), 'Margem: ' + (await page.textContent('#mg-margem')) + ' (' + (await page.textContent('#mg-margem-pct')) + ')');
    ok(/indispon/i.test(await page.textContent('#mg-custo') || ''), 'Custo: ' + (await page.textContent('#mg-custo')));
    ok(numero(await page.textContent('#mg-bruto')) === e2.bruto, 'Margem > receita bruta real: ' + (await page.textContent('#mg-bruto')));
    await page.screenshot({ path: SAIDA + '/2-degustar-margem.png' });
    await page.evaluate(`switchTab('previsao')`);
    await page.waitForTimeout(500);
    ok(await page.inputValue('#pv-meta') === '', 'Previsao: meta da Overwine (80000) NAO herdada');
    ok(/indispon/i.test(await page.textContent('#pv-c-meta') || ''), 'Previsao > meta: ' + (await page.textContent('#pv-c-meta')));
    await page.evaluate(`switchTab('giro')`);
    await page.waitForTimeout(500);
    ok(await page.inputValue('#gr-semanas') === '' && /indispon/i.test(await page.textContent('#gr-aviso-selecao') || ''), 'Giro: cobertura alvo nao herdada, metas indisponiveis');
    await page.evaluate(`switchSection('marketing'); switchTab('radar')`);
    await page.waitForTimeout(500);
    ok(/indispon/i.test(await page.textContent('#radar-content') || ''), 'Radar: indisponivel (grupos sao da Overwine)');
    // assistente
    const chatAntes = httpLog.filter(l => l.path === '/api/chat').length;
    await page.evaluate(`(function(){ var i=document.getElementById('owChatInput'); var f=document.getElementById('owChatFab'); if (f) f.click(); })()`);
    await page.waitForTimeout(300);
    const temChat = await page.evaluate(`!!document.getElementById('owChatInput')`);
    if (temChat) {
      await page.fill('#owChatInput', 'qual o faturamento de hoje?');
      await page.press('#owChatInput', 'Enter');
      await page.waitForTimeout(800);
      const log = await page.textContent('#owChatLog');
      ok(/apenas pela Overwine/i.test(log || ''), 'assistente: bloqueio explicito na tela');
      ok(httpLog.filter(l => l.path === '/api/chat').length === chatAntes, 'assistente: nenhuma chamada a /api/chat');
    } else relato.push('     (campo do assistente nao encontrado pelo id; bloqueio conferido pelo backend abaixo)');
    const tokenSessao = await page.evaluate('SESSION_TOKEN');
    const rChat = await fetchReal(ORIGIN + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tokenSessao }, body: JSON.stringify({ message: 'faturamento de hoje', contas: DG }) });
    ok(rChat.status === 400 && /assistente_mono_conta/.test(await rChat.text()), 'backend recusa o assistente para degustar-ml (400 assistente_mono_conta)');

    // ═══ 3 e 4. CONSOLIDADO ══════════════════════════════════════════════════
    relato.push('═══ 3 e 4. Consolidado (Overwine + Degustar)');
    await page.evaluate(`switchSection('visaogeral'); switchTab('pedidos')`);
    marca = await trocar('*');
    ok(await page.evaluate('selecaoChave()') === OW + ',' + DG, 'selecao = overwine-ml,degustar-ml');
    await abrirPedidos();
    await page.waitForTimeout(1500);
    const p3 = await periodo();
    const e3 = esperado([TOK_OW, TOK_DG], p3.from, p3.to);
    ped = await pedidosNaTela();
    ok(ped.length === 141, `historico: ${ped.length} pedidos = 120 + 21`);
    ok(new Set(ped.map(p => p.id)).size === 141, 'nenhum pedido repetido');
    const naErrada = ped.filter(p => (ehOW(p.id) && p.conta !== OW) || (ehDG(p.id) && p.conta !== DG));
    ok(naErrada.length === 0, 'cada pedido na conta certa (0 na errada)');
    ok(ped.filter(p => p.conta === OW).length === 120 && ped.filter(p => p.conta === DG).length === 21, 'por conta: 120 Overwine, 21 Degustar');
    lin = await linhasDaTabela();
    ok(lin.length > 0 && lin.every(l => (ehOW(l.id) && l.conta === OW && l.tag === 'Overwine') || (ehDG(l.id) && l.conta === DG && l.tag === 'Degustar')), `tabela: ${lin.length} linhas, etiqueta da empresa certa em todas`);
    ok(lin.some(l => l.conta === OW) && lin.some(l => l.conta === DG), 'a primeira pagina intercala as duas empresas por data');
    const mC: any = await page.evaluate('({ bruto: _metrics.periodo.faturamento.bruto, liq: _metrics.periodo.faturamento.liquido, hist: _metrics.janelas.historico, porConta: _metrics.porConta, versao: _metrics.versao, fin: _metrics.financeiro })');
    ok(mC.bruto === e3.bruto && mC.bruto === e1.bruto + e2.bruto, `bruto do periodo = ${mC.bruto} = ${e1.bruto} (Overwine) + ${e2.bruto} (Degustar)`);
    ok(mC.hist.pedidos === 141 && mC.hist.receita === 120 * 300 + 21 * 100, `historico recalculado: ${mC.hist.pedidos} pedidos, receita ${mC.hist.receita}`);
    const ticketCerto = (120 * 300 + 21 * 100) / 141;
    ok(Math.abs(mC.hist.ticketMedio - ticketCerto) < 0.001, `ticket medio RECALCULADO = ${mC.hist.ticketMedio.toFixed(2)} (nao 300+100, nem a media 200)`);
    ok(mC.porConta[OW].periodo.bruto + mC.porConta[DG].periodo.bruto === mC.bruto, 'as partes do backend somam o total');
    ok(mC.liq === null && mC.fin.disponivel === false && mC.fin.contasSemPerfil.join() === DG, 'total liquido ausente: a parte da Degustar tem cobertura parcial');
    const owLiq = e1.bruto * (1 - 0.148 - 0.144);
    ok(mC.fin.porConta[OW].metodo === 'estimado_taxas_da_conta' && Math.abs(mC.fin.porConta[OW].liquido - owLiq) < 0.01, 'parte da Overwine: ESTIMADA com a tabela dela = ' + mC.fin.porConta[OW].liquido.toFixed(2));
    ok(mC.fin.porConta[DG].metodo === 'apurado_pedidos_envios' && mC.fin.porConta[DG].liquido === null, 'parte da Degustar: APURADA, incompleta');
    ok(mC.fin.conhecido.completo === false && mC.fin.conhecido.metodo === 'misto', 'conhecido: subtotal misto, marcado como incompleto');
    ok(mC.fin.conhecido.liquido.receitaCoberta === e1.bruto + e2.receitaComTarifa && mC.fin.conhecido.liquido.fracaoReceita < 1, `subtotal cobre ${mC.fin.conhecido.liquido.receitaCoberta} de ${mC.bruto} (${(mC.fin.conhecido.liquido.fracaoReceita * 100).toFixed(0)}%)`);
    ok(mC.versao === 10, 'versao consolidada = 7 + 3 = ' + mC.versao);
    await page.screenshot({ path: SAIDA + '/3-consolidado-pedidos.png' });
    await page.evaluate(`switchTab('visaogeral')`);
    await page.waitForTimeout(800);
    ok(numero(await page.textContent('#kpi-faturamento')) === e3.bruto, 'card Faturamento = ' + (await page.textContent('#kpi-faturamento')));
    ok(/indispon/i.test(await page.textContent('#kpi-liq') || ''), 'card Liquido: ' + (await page.textContent('#kpi-liq')) + ' · ' + (await page.textContent('#kpi-liq-pct')));
    ok(/^subtotal conhecido/.test(await page.textContent('#kpi-liq-pct') || ''), 'o subtotal do consolidado aparece como subtotal, com a cobertura');
    ok(/consolidada/i.test(await page.textContent('#card-reputacao') || ''), 'reputacao: indisponivel na visao consolidada');
    ok(await page.evaluate(`document.getElementById('kpi-pub-input').disabled`), 'publicidade manual fechada no consolidado');
    const visitas = await page.evaluate('visitasPorDia.length ? visitasPorDia[visitasPorDia.length - 1].total : null');
    ok(visitas === 230, `visitas por dia somadas: ${visitas} = 200 + 30`);
    ok(/Consolidado/.test(await page.textContent('#main-header .logo') || ''), 'titulo: ' + (await page.textContent('#main-header .logo')));
    await page.screenshot({ path: SAIDA + '/3-consolidado-geral.png' });
    // catalogo e estoque: mesmo SKU, duas linhas
    const itens: any[] = await page.evaluate('allItems.map(i => ({ id: i.id, conta: i.conta, sku: itemSKU(i), est: i.available_quantity }))');
    ok(itens.length === 2 && itens.some(i => i.conta === OW && i.id === 'MLB1000001') && itens.some(i => i.conta === DG && i.id === 'MLB2000001'), 'catalogo: 2 anuncios, um de cada empresa');
    ok(new Set(itens.map(i => i.sku)).size === 2, 'o mesmo SKU 21003 vira duas chaves: ' + itens.map(i => i.sku).join(' | '));
    await page.evaluate(`switchTab('consolidado')`);
    await page.waitForFunction(`pedidosEmMemoria() && /21003/.test(document.getElementById('tab-consolidado').textContent)`, null, { timeout: 60_000 });
    const grupos: any[] = await page.evaluate(`(function(){ var g = {}; allItems.forEach(function(i){ var k = itemSKU(i); (g[k] = g[k] || []).push(i); }); return Object.keys(g).map(function(k){ var e = consolidarEstoqueGrupo(g[k]); return { sku: k, saldo: e.proprio + e.full }; }); })()`);
    ok(grupos.length === 2 && grupos.map(g => g.saldo).sort((a, b) => a - b).join() === '8,40', 'estoque por produto: duas linhas, saldos 40 e 8 — NAO somados em 48: ' + JSON.stringify(grupos));
    const consTxt = await page.textContent('#tab-consolidado');
    ok(/21003 · Overwine/.test(consTxt || '') && /21003 · Degustar/.test(consTxt || ''), 'aba Consolidado por produto mostra as duas chaves');
    // detalhe de um pedido da Degustar dentro do consolidado
    await page.evaluate(`switchTab('pedidos')`);
    await page.waitForTimeout(300);
    const mlAntes = mlLog.length; const httpAntes = httpLog.length;
    await page.evaluate(`openOrderDetail('200003')`);
    await page.waitForFunction(`odOrderCache['200003'] !== undefined && odDiscountCache['200003'] !== undefined`, null, { timeout: 30_000 });
    const detHttp = httpLog.slice(httpAntes).filter(l => /^\/api\/ml\/(order|shipment|order-discounts)$/.test(l.path));
    ok(detHttp.length === 3 && detHttp.every(l => /conta=degustar-ml/.test(l.query) && l.status === 200), 'detalhe do pedido 200003: 3 consultas, todas com conta=degustar-ml e 200');
    const detMl = mlLog.slice(mlAntes);
    ok(detMl.length > 0 && detMl.every(l => l.loja === DG), 'o Mercado Livre recebeu essas consultas com o token da Degustar');
    ok(/Degustar/.test(await page.textContent('#od-body, #order-panel') || ''), 'o painel do pedido informa a empresa');
    await page.evaluate('closeOrderDetail()');
    // cancelados
    await page.evaluate(`switchSection('financeiro'); switchTab('cancelamentos')`);
    await page.waitForFunction('allCancelledOrders.length > 0', null, { timeout: 30_000 });
    const canc: any[] = await page.evaluate('allCancelledOrders.map(o => ({ id: Number(o.id), conta: o.conta }))');
    ok(canc.length === 6 && canc.every(c => (c.id < 200000 ? c.conta === OW : c.conta === DG)), 'cancelamentos: 4 Overwine + 2 Degustar, cada um na conta certa');
    await page.evaluate(`switchTab('margem')`);
    await page.waitForFunction(`!/Calculando/.test(document.getElementById('mg-table').textContent)`, null, { timeout: 30_000 });
    ok(/indispon/i.test(await page.textContent('#mg-margem') || '') && numero(await page.textContent('#mg-bruto')) === e3.bruto, 'Margem consolidada: receita real, margem indisponivel');
    const etqs = await page.evaluate(`[...document.querySelectorAll('#mg-table .tag-conta')].map(e => e.textContent)`);
    ok(etqs.includes('Overwine') && etqs.includes('Degustar'), 'Margem: o mesmo SKU em duas linhas, uma por empresa');
    await page.screenshot({ path: SAIDA + '/3-consolidado-margem.png' });
    const redeC = dadosDe(marca).filter(l => /^\/api\/(orders|items)\//.test(l.path) && l.path !== '/api/orders/refresh');
    ok(redeC.every(l => /contas=overwine-ml%2Cdegustar-ml/.test(l.query)), `leituras do consolidado (${redeC.length}) todas com contas=overwine-ml,degustar-ml`);

    // ═══ 5. TROCA RAPIDA DE CONTA E PERIODO ══════════════════════════════════
    relato.push('═══ 5. Troca rapida de conta e periodo');
    await page.evaluate(`switchSection('visaogeral'); switchTab('pedidos')`);
    // periodo novo e, SEM esperar a carga dele, troca de conta
    await page.selectOption('#gdr-preset', 'ultimos:3');
    marca = httpLog.length;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 60_000 }),
      page.evaluate(`trocarSelecao(['degustar-ml'])`),
    ]);
    // a pagina acabou de recarregar: troca o periodo de novo antes de a carga terminar, e a conta em seguida
    await page.waitForSelector('#gdr-preset', { state: 'attached' });
    await page.waitForFunction('typeof trocarSelecao === "function" && SESSION_TOKEN !== null', null, { timeout: 30_000 });
    await page.evaluate(`gdrDefinir('ultimos:6')`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 60_000 }),
      page.evaluate(`trocarSelecao(['overwine-ml'])`),
    ]);
    await page.waitForFunction('typeof trocarSelecao === "function" && SESSION_TOKEN !== null', null, { timeout: 30_000 });
    const marcaFinal = httpLog.length;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 60_000 }),
      page.evaluate(`trocarSelecao(['degustar-ml'])`),
    ]);
    await pronto();
    // e ainda uma troca de periodo em cima da carga
    await page.selectOption('#gdr-preset', 'mes_atual');
    await page.waitForFunction('!document.getElementById("gdr-preset").disabled', null, { timeout: 60_000 });
    await page.selectOption('#gdr-preset', 'ultimos:3');
    await page.waitForFunction('!document.getElementById("gdr-preset").disabled && document.getElementById("gdr-loading").style.display === "none"', null, { timeout: 60_000 });
    await abrirPedidos();
    await page.waitForTimeout(1500);
    const p5 = await periodo();
    const e5 = esperado([TOK_DG], p5.from, p5.to);
    ok(await page.evaluate('selecaoChave()') === DG && p5.preset === 'ultimos:3', `estado final: ${await page.evaluate('selecaoRotulo()')} / ${p5.label}`);
    ped = await pedidosNaTela();
    ok(ped.length === 21 && ped.every(p => ehDG(p.id) && p.conta === DG), 'pedidos em memoria: so os 21 da Degustar');
    const itensFim: any[] = await page.evaluate('allItems.map(i => i.id)');
    ok(itensFim.length === 1 && itensFim[0] === 'MLB2000001', 'catalogo em memoria: so o anuncio da Degustar');
    const mF: any = await page.evaluate('({ bruto: _metrics.periodo.faturamento.bruto, from: _metrics.periodo.fromYmd, to: _metrics.periodo.toYmd, contas: _metrics.contas })');
    // Com o historico em memoria os cards saem dos PEDIDOS em memoria (regra de
    // sempre); o agregado do backend so vale se for exatamente do periodo.
    const liq5: any = await page.evaluate('calcLiquidoPeriodo()');
    ok(mF.contas.join() === DG, 'agregado em memoria e da conta ' + mF.contas.join());
    ok(liq5.bruto === e5.bruto && liq5.liquido === null && liq5.semFinanceiro === true, `bruto do periodo final (${p5.from}..${p5.to}) = ${liq5.bruto} = esperado ${e5.bruto}; liquido com cobertura parcial`);
    ok(mF.from === p5.from && mF.to === p5.to, 'o apurado em memoria e do periodo final (pedido ao backend a cada troca de periodo)');
    lin = await linhasDaTabela();
    ok(lin.length > 0 && lin.every(l => ehDG(l.id) && l.conta === DG), `tabela: ${lin.length} linhas, so Degustar`);
    await page.evaluate(`switchTab('visaogeral')`);
    await page.waitForTimeout(500);
    ok(numero(await page.textContent('#kpi-faturamento')) === e5.bruto, 'card Faturamento = ' + (await page.textContent('#kpi-faturamento')) + ' (Degustar, ultimos 3 meses)');
    const depois = dadosDe(marcaFinal).filter(l => l.t > 0);
    const daUltima = httpLog.slice(marcaFinal);
    const idxCarga = daUltima.findIndex(l => l.path === '/api/orders/contas');
    const aposCarga = daUltima.slice(idxCarga).filter(l => /^\/api\/(orders|items|ml)\//.test(l.path) && l.path !== '/api/orders/contas');
    ok(aposCarga.length > 0 && aposCarga.every(l => /contas?=degustar-ml/.test(l.query) || (l.path === '/api/orders/refresh' && /degustar-ml/.test(l.req || ''))), `na pagina final, as ${aposCarga.length} requisicoes de dados sao todas da Degustar`);
    void depois;
    await page.screenshot({ path: SAIDA + '/5-troca-rapida-final.png' });

    // ═══ 6. ATUALIZACAO AUTOMATICA POR CONTA ═════════════════════════════════
    relato.push('═══ 6. Atualizacao automatica por conta');
    const versaoOWAntes = (await readManifest(cache, 'ativos'))!.versao;
    const versaoDGAntes = (await readManifest(cacheDG, 'ativos'))!.versao;
    // 6a. Degustar selecionada: venda nova NA DEGUSTAR aparece; venda nova NA OVERWINE nao.
    await abrirPedidos();
    lojas[TOK_DG].pedidos.push(pedidoML(290001, 0, 150, 'MLB2000001', 'COMPRADOR_SIMULADO_DG', { tarifa: DG_TARIFA }));
    lojas[TOK_OW].pedidos.push(pedidoML(190001, 0, 450, 'MLB1000001', 'COMPRADOR_SIMULADO_OW', { tarifa: 40 }));
    const t0 = Date.now();
    await page.waitForFunction(`allOrders.some(o => String(o.id) === '290001')`, null, { timeout: 90_000 });
    relato.push(`     venda 290001 (Degustar) apareceu em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    ped = await pedidosNaTela();
    ok(ped.some(p => p.id === 290001 && p.conta === DG), 'venda nova da Degustar entrou na tela da Degustar');
    ok(!ped.some(p => ehOW(p.id)), 'a venda nova da Overwine (190001) NAO entrou na tela da Degustar');
    const refDG = httpLog.filter(l => l.path === '/api/orders/refresh' && l.t >= t0);
    ok(refDG.length > 0 && refDG.every(l => JSON.parse(l.req || '{}').conta === DG), `refresh pedido ${refDG.length}x, sempre com conta=degustar-ml`);
    ok(mlLog.filter(l => l.t >= t0 && /^\/orders\/search/.test(l.path)).every(l => l.loja === DG), 'a sincronizacao consultou o Mercado Livre so com o token da Degustar');
    ok((await readManifest(cache, 'ativos'))!.versao === versaoOWAntes, 'o snapshot da Overwine nao foi tocado (versao ' + versaoOWAntes + ')');
    ok((await readManifest(cacheDG, 'ativos'))!.versao > versaoDGAntes, 'o snapshot da Degustar avancou de versao');
    await page.waitForFunction(`_metrics && _metrics.janelas.historico.pedidos === 22`, null, { timeout: 60_000 });
    ok(true, 'os cards recarregaram: historico da Degustar com 22 pedidos');

    // 6b. Consolidado: cada conta sincroniza por si; as duas vendas aparecem.
    marca = await trocar('*');
    await abrirPedidos();
    const t1 = Date.now();
    await page.waitForFunction(`allOrders.some(o => String(o.id) === '190001') && allOrders.some(o => String(o.id) === '290001')`, null, { timeout: 90_000 });
    relato.push(`     consolidado: vendas 190001 e 290001 visiveis em ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    lojas[TOK_OW].pedidos.push(pedidoML(190002, 0, 450, 'MLB1000001', 'COMPRADOR_SIMULADO_OW', { tarifa: 40 }));
    lojas[TOK_DG].pedidos.push(pedidoML(290002, 0, 150, 'MLB2000001', 'COMPRADOR_SIMULADO_DG', { tarifa: DG_TARIFA }));
    // o backend tem cooldown por conta: aguarda a proxima janela
    const t2 = Date.now();
    await page.waitForFunction(`allOrders.some(o => String(o.id) === '190002') && allOrders.some(o => String(o.id) === '290002')`, null, { timeout: 150_000 });
    relato.push(`     consolidado: vendas 190002 e 290002 apareceram em ${((Date.now() - t2) / 1000).toFixed(1)}s`);
    ped = await pedidosNaTela();
    ok(ped.find(p => p.id === 190002)?.conta === OW && ped.find(p => p.id === 290002)?.conta === DG, 'as duas vendas novas entraram, cada uma na sua conta');
    ok(ped.length === 145 && new Set(ped.map(p => p.id)).size === 145, `historico consolidado: ${ped.length} pedidos sem repeticao (141 + 4 vendas novas)`);
    const refC = httpLog.filter(l => l.path === '/api/orders/refresh' && l.t >= t1).map(l => JSON.parse(l.req || '{}').conta);
    ok(refC.includes(OW) && refC.includes(DG) && refC.every(c => c === OW || c === DG), `refresh por conta no consolidado: ${refC.filter(c => c === OW).length}x overwine-ml, ${refC.filter(c => c === DG).length}x degustar-ml`);
    await page.waitForFunction(`_metrics && _metrics.janelas.historico.pedidos === 145`, null, { timeout: 60_000 });
    ok(true, 'os cards do consolidado recarregaram: 145 pedidos');

    // 6c. Overwine sozinha de novo: corpo {} de sempre, e nada da Degustar.
    marca = await trocar('alemmar');
    await abrirPedidos();
    lojas[TOK_OW].pedidos.push(pedidoML(190003, 0, 450, 'MLB1000001', 'COMPRADOR_SIMULADO_OW', { tarifa: 40 }));
    lojas[TOK_DG].pedidos.push(pedidoML(290003, 0, 150, 'MLB2000001', 'COMPRADOR_SIMULADO_DG', { tarifa: DG_TARIFA }));
    const t3 = Date.now();
    await page.waitForFunction(`allOrders.some(o => String(o.id) === '190003')`, null, { timeout: 150_000 });
    relato.push(`     Overwine: venda 190003 apareceu em ${((Date.now() - t3) / 1000).toFixed(1)}s`);
    ped = await pedidosNaTela();
    ok(ped.every(p => ehOW(p.id) && p.conta === null), `Overwine de volta: ${ped.length} pedidos, nenhum da Degustar, sem marca`);
    const refOW = httpLog.filter(l => l.path === '/api/orders/refresh' && l.t >= t3);
    ok(refOW.length > 0 && refOW.every(l => l.req === '{}'), `refresh da Overwine com o corpo {} de sempre (${refOW.length}x)`);
    const redeFim = dadosDe(marca);
    ok(redeFim.filter(l => /[?&]contas?=/.test(l.query)).length === 0, `Overwine de volta: ${redeFim.length} requisicoes de dados, nenhuma com conta/contas`);
    ok(await page.inputValue('#kpi-pub-input') !== '' || await page.evaluate('kpiPubManual') === 555, 'a publicidade manual da Overwine (555) continua la');

    // nenhuma consulta ao Mercado Livre cruzou vendedor e token
    const cruzadas = mlLog.filter(l => l.loja.startsWith('SEM_TOKEN'));
    ok(cruzadas.length === 0, `Mercado Livre: ${mlLog.length} consultas, todas com token de uma das duas lojas`);

    await browser.close();
    const graves = erros.filter(e => !/favicon|net::ERR|Failed to load resource/.test(e));
    const texto = ['── RELATO ──', ...relato, '── erros de pagina ──', ...(graves.length ? graves : ['(nenhum)'])].join('\n');
    writeFileSync(SAIDA + '/relato.txt', texto);
    console.log(texto);
    expect(graves).toEqual([]);
  }, 900_000);

  it('trocar de empresa preserva a sessao: sem nova senha, nos dois modos de login', async () => {
    const browser = await chromium.launch({ headless: true });
    const relato: string[] = [];
    const ok = (c: boolean, t: string) => { relato.push((c ? 'ok   ' : 'ERRO ') + t); expect(c, t).toBe(true); };
    const logins = () => httpLog.filter(l => l.path === '/api/auth/login').length;

    for (const manter of [false, true]) {
      const modo = manter ? 'manter conectado MARCADO (localStorage, 30 dias)' : 'manter conectado DESMARCADO (sessionStorage, so esta aba)';
      relato.push('═══ ' + modo);
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page = await ctx.newPage();
      const telasDeLogin: string[] = [];
      await page.exposeFunction('__loginVisivel', (onde: string) => { telasDeLogin.push(onde); });
      // Vigia a tela de senha em TODAS as cargas da pagina: ela nao pode piscar.
      await page.addInitScript(`
        window.addEventListener('DOMContentLoaded', function () {
          var el = document.getElementById('setup-screen');
          if (!el) return;
          var ver = function () { if (getComputedStyle(el).display !== 'none' && window.__vigiar) window.__loginVisivel(location.href); };
          new MutationObserver(ver).observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
          window.__vigiar = sessionStorage.getItem('e2e_vigiar') === '1';
          ver();
        });
      `);
      await page.goto(ORIGIN + '/');
      if (!manter) await page.uncheck('#viewer-keep'); else await page.check('#viewer-keep');
      await page.fill('#viewer-pass', TEST_ENV.DASHBOARD_PASSWORD);
      await page.press('#viewer-pass', 'Enter');
      await page.waitForSelector('#main-header', { state: 'visible', timeout: 60_000 });
      await page.waitForFunction('!_loadAllEmCurso && _metrics !== null', null, { timeout: 60_000 });
      await page.evaluate(`sessionStorage.setItem('e2e_vigiar', '1'); window.__vigiar = true;`);
      const token0 = await page.evaluate('SESSION_TOKEN');
      const loginsAntes = logins();
      const onde = await page.evaluate(`({ local: !!localStorage.getItem('ow_sessao'), sessao: !!sessionStorage.getItem('ow_sessao') })`) as { local: boolean; sessao: boolean };
      ok(manter ? (onde.local && !onde.sessao) : (onde.sessao && !onde.local), 'token guardado so em ' + (manter ? 'localStorage' : 'sessionStorage'));

      for (const [empresa, esperada] of [['degustar', DG], ['*', OW + ',' + DG], ['alemmar', OW], ['degustar', DG]] as Array<[string, string]>) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'load', timeout: 60_000 }),
          page.selectOption('#conta-empresa', empresa),
        ]);
        await page.waitForSelector('#main-header', { state: 'visible', timeout: 60_000 });
        await page.waitForFunction('!_loadAllEmCurso && _metrics !== null', null, { timeout: 60_000 });
        const st = await page.evaluate('({ sel: selecaoChave(), tok: SESSION_TOKEN, login: getComputedStyle(document.getElementById("setup-screen")).display })') as { sel: string; tok: string; login: string };
        ok(st.sel === esperada && st.tok === token0 && st.login === 'none', `troca para ${esperada}: mesma sessao, sem tela de senha`);
      }
      ok(logins() === loginsAntes, 'nenhum novo POST /api/auth/login em 4 trocas');
      ok(telasDeLogin.length === 0, 'a tela de senha nao apareceu em nenhum momento (nem piscou)');
      const sessoes = httpLog.filter(l => l.path === '/api/auth/session');
      ok(sessoes.length > 0 && sessoes.slice(-4).every(l => l.status === 200), 'cada recarga validou a sessao no backend (200)');

      // Sair encerra a sessao; a selecao guardada nao da acesso a nada.
      await page.evaluate('doLogout()');
      await page.waitForSelector('#setup-screen', { state: 'visible', timeout: 30_000 });
      const r = await fetchReal(ORIGIN + '/api/orders/status?alvo=ativos&contas=' + DG, { headers: { authorization: 'Bearer ' + token0 } });
      ok(r.status === 401, 'apos Sair, o token antigo e recusado (401) mesmo com a conta na URL');
      await ctx.close();
    }
    await browser.close();
    const texto = ['── SESSAO NA TROCA DE EMPRESA ──', ...relato].join('\n');
    writeFileSync(SAIDA + '/relato-sessao.txt', texto);
    console.log(texto);
  }, 300_000);

  it('filtros: Periodo > Personalizado cabe na tela, sem corte nem rolagem horizontal', async () => {
    const browser = await chromium.launch({ headless: true });
    const relato: string[] = [];
    const ok = (c: boolean, t: string) => { relato.push((c ? 'ok   ' : 'ERRO ') + t); expect(c, t).toBe(true); };
    const larguras: Array<[string, number, number]> = [
      ['notebook 1366', 1366, 768], ['notebook 1280', 1280, 720], ['tablet 1024', 1024, 768],
      ['tablet 768', 768, 1024], ['celular 390', 390, 844],
    ];
    const selecoes: Array<[string, string]> = [['alemmar', OW], ['degustar', DG], ['*', OW + ',' + DG]];

    // UM login para todas as larguras: o backend limita a 5 logins por minuto.
    const ctx = await browser.newContext({ viewport: { width: larguras[0][1], height: larguras[0][2] } });
    const page = await ctx.newPage();
    await page.goto(ORIGIN + '/');
    await page.fill('#viewer-pass', TEST_ENV.DASHBOARD_PASSWORD);
    await page.press('#viewer-pass', 'Enter');
    await page.waitForSelector('#main-header', { state: 'visible', timeout: 60_000 });
    await page.waitForFunction('!_loadAllEmCurso && _metrics !== null', null, { timeout: 60_000 });

    for (const [nome, w, h] of larguras) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(200);

      for (const [empresa, esperada] of selecoes) {
        if (await page.evaluate('selecaoChave()') !== esperada) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'load', timeout: 60_000 }),
            page.selectOption('#conta-empresa', empresa),
          ]);
          await page.waitForSelector('#main-header', { state: 'visible', timeout: 60_000 });
          await page.waitForFunction('!_loadAllEmCurso && _metrics !== null', null, { timeout: 60_000 });
        }
        await page.selectOption('#gdr-preset', 'custom');
        await page.waitForSelector('#gdr-custom.aberto', { state: 'visible' });
        await page.evaluate(`document.getElementById('section-nav').scrollIntoView({ block: 'center' })`);
        await page.waitForTimeout(250);

        const m: any = await page.evaluate(`(function () {
          var vw = document.documentElement.clientWidth;
          var nav = document.getElementById('section-nav').getBoundingClientRect();
          var ids = ['conta-empresa', 'conta-canal', 'gdr-preset', 'gdr-de', 'gdr-ate', 'gdr-apply'];
          var els = ids.map(function (id) {
            var el = document.getElementById(id), r = el.getBoundingClientRect();
            var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            var topo = document.elementFromPoint(cx, cy);
            return { id: id, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height),
              dentroDaTela: r.left >= 0 && r.right <= vw + 0.5 && r.width > 20 && r.height > 10,
              dentroDaBarra: r.left >= nav.left - 0.5 && r.right <= nav.right + 0.5 && r.top >= nav.top - 0.5 && r.bottom <= nav.bottom + 0.5,
              alcancavel: !!topo && (topo === el || el.contains(topo)) };
          });
          var navEl = document.getElementById('section-nav');
          return { vw: vw, rolagemPagina: document.documentElement.scrollWidth - vw, rolagemBarra: navEl.scrollWidth - navEl.clientWidth,
            alturaBarra: Math.round(nav.height), barraDireita: Math.round(nav.right), els: els };
        })()`);
        const rot = `${nome} / ${esperada}`;
        // Abaixo de 768 px a pagina ja rolava na horizontal ANTES desta correcao, por
        // causa dos cards de grafico (largura minima fixa) — nao dos filtros. La o que
        // se exige e que a BARRA de filtros caiba; a rolagem dos cards e outro defeito.
        if (w >= 768) ok(m.rolagemPagina <= 0, `${rot}: sem rolagem horizontal na pagina (${m.rolagemPagina}px)`);
        else {
          ok(m.barraDireita <= m.vw + 0.5, `${rot}: a barra de filtros cabe na tela (ate ${m.barraDireita} de ${m.vw})`);
          relato.push(`     (pagina rola ${m.rolagemPagina}px na horizontal por causa dos cards: defeito anterior, fora desta correcao)`);
        }
        ok(m.rolagemBarra <= 0, `${rot}: sem conteudo escondido na barra (${m.rolagemBarra}px)`);
        for (const e of m.els) {
          ok(e.dentroDaTela && e.dentroDaBarra && e.alcancavel, `${rot}: ${e.id} inteiro e clicavel (x ${e.left}..${e.right} de ${m.vw}, ${e.w}x${e.h})`);
        }
        // Funciona: escolher o intervalo e aplicar.
        const de = ymd(new Date(Date.now() - 9 * 86400_000)), ate = ymd(new Date());
        await page.fill('#gdr-de', de);
        await page.fill('#gdr-ate', ate);
        await page.click('#gdr-apply');
        await page.waitForFunction('!document.getElementById("gdr-preset").disabled && globalDateRange.from === "' + de + '"', null, { timeout: 60_000 });
        ok(await page.evaluate('globalDateRange.preset') === 'custom' && await page.evaluate('globalDateRange.to') === ate, `${rot}: intervalo ${de}..${ate} aplicado`);
        ok(await page.evaluate('selecaoChave()') === esperada, `${rot}: a selecao nao mudou ao aplicar o periodo`);
        relato.push(`     altura da barra: ${m.alturaBarra}px`);
        await page.screenshot({ path: SAIDA + `/filtros-${w}-${empresa === '*' ? 'consolidado' : empresa}.png`, clip: { x: 0, y: 0, width: w, height: Math.min(h, 700) } }).catch(() => {});
        await page.selectOption('#gdr-preset', 'mes_atual');
        await page.waitForFunction('!document.getElementById("gdr-preset").disabled', null, { timeout: 60_000 });
      }
    }
    await ctx.close();
    await browser.close();
    const texto = ['── FILTROS ──', ...relato].join(String.fromCharCode(10));
    writeFileSync(SAIDA + '/relato-filtros.txt', texto);
    console.log(texto);
  }, 600_000);
});
