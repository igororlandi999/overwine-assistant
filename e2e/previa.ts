/**
 * Prévia local para REVISÃO VISUAL — dashboard real, backend real, dados SIMULADOS.
 *
 *   npx vite-node e2e/previa.ts            (porta 5600)
 *   PREVIA_PORTA=5700 npx vite-node e2e/previa.ts
 *
 * Abre em http://127.0.0.1:5600/ . A senha aparece no terminal. A página leva
 * uma faixa fixa "DADOS SIMULADOS": nada do que ela mostra vem da Overwine nem
 * da Degustar, e nada do que se faz nela chega ao Mercado Livre ou à produção.
 *
 * Fica no ar até Ctrl+C. Os dados vivem em memória e renascem a cada início.
 */
import { iniciarAmbiente, SENHA, caminhoDoDashboard, DG_COBERTOS, DG_TARIFA, DG_FRETE } from './ambiente.js';

const porta = Number(process.env.PREVIA_PORTA || 5600);
const amb = await iniciarAmbiente({ porta, faixa: true, silencioso: true });

console.log([
  '',
  '  PREVIA LOCAL — DADOS SIMULADOS',
  '  ' + amb.origem + '/',
  '  senha: ' + SENHA,
  '  dashboard: ' + caminhoDoDashboard(),
  '',
  '  Overwine (simulada): 120 pedidos de R$ 300; tarifa e frete ESTIMADOS pela tabela dela.',
  '  Degustar (simulada): 21 pedidos de R$ 100; os ' + DG_COBERTOS + ' mais novos com tarifa real R$ ' + DG_TARIFA +
    ' e frete real R$ ' + DG_FRETE + '; os demais sem (cobertura parcial).',
  '  Mesmo SKU e mesmo titulo nas duas, de proposito.',
  '',
  '  Ctrl+C encerra.',
  '',
].join('\n'));

process.on('SIGINT', async () => { await amb.encerrar(); process.exit(0); });
setInterval(() => { }, 1 << 30);   // mantem o processo vivo
