#!/usr/bin/env node
/**
 * SERVIDOR BURLINGTON - Dashboard + API + Cron
 *
 * Funcionalidades:
 *   - Serve o dashboard em http://localhost:3100
 *   - API /api/atualizar -> executa atualização DataJud
 *   - API /api/status -> retorna status dos processos
 *   - API /api/processos -> retorna dados dos processos
 *   - Cron automático: atualiza diariamente às 07:00 e 19:00
 *
 * Uso: node burlington-server.js
 */

const express = require('express');
const cron = require('node-cron');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3100;

// === FILES ===
const IS_VERCEL = process.env.VERCEL === '1';
const DATA_FILE = path.join(__dirname, 'burlington_processos_data.json');
const API_KEY = 'cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==';
const DELAY_MS = 500;
const COMUNICA_CACHE_FILE = path.join(__dirname, 'burlington_comunicacoes_cache.json');

// Safe write (no-op on Vercel serverless - read-only filesystem)
function safeWriteFile(filePath, data) {
  try { fs.writeFileSync(filePath, data, 'utf-8'); } catch(e) { console.log('[FS] Write skipped (read-only):', e.message); }
}

// === COMUNICA PJE API (REAL-TIME) ===
function queryComunicaPJe(numeroLimpo) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'comunicaapi.pje.jus.br',
      path: '/api/v1/comunicacao?numeroProcesso=' + numeroLimpo,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve({ success: true, count: j.count || 0, items: j.items || [] });
        } catch (e) { resolve({ success: false, error: e.message }); }
      });
    });
    req.on('error', e => resolve({ success: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'timeout' }); });
    req.end();
  });
}

// Parse intimation text to extract key info
function parseIntimacao(texto) {
  const info = { tipo_decisao: '', prazo_dias: null, prazo_descricao: '', conteudo_resumido: '', urgente: false };
  if (!texto) return info;
  const t = texto.toUpperCase();

  // Detect decision types and extract deadlines
  if (t.includes('DESCONSIDERAÇÃO DA PERSONALIDADE')) {
    info.tipo_decisao = 'INCIDENTE DESCONSIDERACAO PJ';
    info.urgente = true;
    info.prazo_dias = 15;
    info.prazo_descricao = '15 dias para defesa do incidente de desconsideracao';
  }
  if (t.includes('AUDIÊNCIA') || t.includes('AUDIENCIA')) {
    info.tipo_decisao = info.tipo_decisao ? info.tipo_decisao + ' + AUDIENCIA' : 'AUDIENCIA DESIGNADA';
    info.urgente = true;
  }
  if (t.includes('BLOQUEIO') || t.includes('SISBAJUD') || t.includes('BACENJUD')) {
    info.tipo_decisao = info.tipo_decisao || 'BLOQUEIO BANCARIO';
    info.urgente = true;
  }
  if (t.includes('PENHORA')) {
    info.tipo_decisao = info.tipo_decisao || 'PENHORA';
    info.urgente = true;
  }
  if (t.includes('SENTENÇA') || t.includes('SENTENCA')) {
    info.tipo_decisao = info.tipo_decisao || 'SENTENCA';
    info.prazo_dias = 8;
    info.prazo_descricao = '8 dias uteis para recurso ordinario';
  }
  if (t.includes('ACÓRDÃO') || t.includes('ACORDAO')) {
    info.tipo_decisao = info.tipo_decisao || 'ACORDAO';
    info.prazo_dias = 8;
    info.prazo_descricao = '8 dias uteis para recurso de revista';
  }
  if (t.includes('DESPACHO')) {
    info.tipo_decisao = info.tipo_decisao || 'DESPACHO';
  }

  // Extract prazo from text
  const prazoMatch = texto.match(/prazo de (\d+) dias?/i);
  if (prazoMatch) {
    info.prazo_dias = parseInt(prazoMatch[1]);
    info.prazo_descricao = prazoMatch[1] + ' dias conforme determinacao judicial';
  }

  // Check for RAPHAEL or FERNANDA mentioned
  if (t.includes('RAPHAEL')) info.conteudo_resumido += '[MENCIONA RAPHAEL] ';
  if (t.includes('FERNANDA')) info.conteudo_resumido += '[MENCIONA FERNANDA] ';
  if (t.includes('BRASSPLATE')) info.conteudo_resumido += '[MENCIONA BRASSPLATE] ';

  // Summarize first 300 chars
  info.conteudo_resumido += texto.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 300);

  return info;
}

function calcPrazoFinal(dataDisp, prazoDias) {
  if (!dataDisp || !prazoDias) return null;
  const d = new Date(dataDisp);
  // Count business days (approximation: add ~40% for weekends)
  const calDays = Math.ceil(prazoDias * 1.4) + 1; // +1 for publication day
  d.setDate(d.getDate() + calDays);
  return d.toISOString().substring(0, 10);
}

// Full Comunica PJe update for all processes
async function runComunicaUpdate(source = 'manual') {
  const rawData = fs.readFileSync(DATA_FILE, 'utf-8');
  const data = JSON.parse(rawData);
  const processos = data.processos;

  let cache = {};
  if (fs.existsSync(COMUNICA_CACHE_FILE)) {
    try { cache = JSON.parse(fs.readFileSync(COMUNICA_CACHE_FILE, 'utf-8')); } catch(e) {}
  }

  console.log('[COMUNICA] Iniciando consulta tempo real (' + source + ')...');
  let found = 0, total = 0;

  for (let i = 0; i < processos.length; i++) {
    const p = processos[i];
    const num = (p.numero || '').replace(/[^0-9]/g, '');
    if (!num || num.length < 15) continue;
    total++;

    const result = await queryComunicaPJe(num);
    if (result.success && result.count > 0) {
      found++;
      const items = result.items.map(it => ({
        id: it.id,
        data: it.data_disponibilizacao,
        tipo: it.tipoComunicacao,
        orgao: it.nomeOrgao,
        tribunal: it.siglaTribunal,
        meio: it.meiocompleto,
        link: it.link,
        destinatarios: (it.destinatarios || []).map(d => d.nome),
        advogados: (it.destinatarioadvogados || []).map(a => a.advogado?.nome + ' OAB ' + a.advogado?.uf_oab + ' ' + a.advogado?.numero_oab),
        parsed: parseIntimacao(it.texto),
        texto_completo: it.texto
      }));

      cache[p.id] = {
        numero: p.numero,
        reclamante: p.reclamante,
        total_comunicacoes: result.count,
        ultima_verificacao: new Date().toISOString(),
        comunicacoes: items
      };
    } else {
      // Keep old cache if exists, just update timestamp
      if (cache[p.id]) {
        cache[p.id].ultima_verificacao = new Date().toISOString();
      } else {
        cache[p.id] = {
          numero: p.numero,
          reclamante: p.reclamante,
          total_comunicacoes: 0,
          ultima_verificacao: new Date().toISOString(),
          comunicacoes: []
        };
      }
    }

    // Rate limit: 20 requests per minute (we saw x-ratelimit-remaining: 19)
    if (i < processos.length - 1) await sleep(3200); // ~18 req/min to be safe
  }

  safeWriteFile(COMUNICA_CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log('[COMUNICA] Concluido: ' + found + '/' + total + ' com comunicacoes');
  return { found, total, timestamp: new Date().toISOString() };
}

// Track update state
let updateState = {
  running: false,
  progress: 0,
  total: 0,
  currentProcess: '',
  lastUpdate: null,
  lastResult: null,
  log: []
};

// === HELPERS ===
function cleanNumero(numero) {
  return (numero || '').replace(/[^0-9]/g, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(isoDate) {
  if (!isoDate) return null;
  if (isoDate.includes('T')) return isoDate.substring(0, 10);
  if (isoDate.length >= 8 && !isoDate.includes('-')) {
    return isoDate.substring(0, 4) + '-' + isoDate.substring(4, 6) + '-' + isoDate.substring(6, 8);
  }
  return isoDate;
}

function queryDataJud(numeroLimpo, tribunal) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      query: { match: { numeroProcesso: numeroLimpo } },
      size: 5
    });

    const options = {
      hostname: 'api-publica.datajud.cnj.jus.br',
      path: `/api_publica_${tribunal}/_search`,
      method: 'POST',
      headers: {
        'Authorization': `ApiKey ${API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode !== 200) {
            resolve({ found: false, error: `HTTP ${res.statusCode}` });
            return;
          }
          const hits = j.hits?.hits || [];
          if (hits.length === 0) {
            resolve({ found: false });
            return;
          }

          let allMovimentos = [];
          let bestHit = hits[0]._source;

          hits.forEach(hit => {
            const src = hit._source;
            (src.movimentos || []).forEach(m => {
              allMovimentos.push({
                data: formatDate(m.dataHora),
                dataHora: m.dataHora,
                nome: m.nome,
                codigo: m.codigo,
                grau: src.grau,
                orgao: src.orgaoJulgador?.nome,
                complementos: (m.complementosTabelados || []).map(c => ({
                  nome: c.nome, valor: c.valor, descricao: c.descricao
                }))
              });
            });
            if (src.dataHoraUltimaAtualizacao > bestHit.dataHoraUltimaAtualizacao) {
              bestHit = src;
            }
          });

          allMovimentos.sort((a, b) => (b.dataHora || '').localeCompare(a.dataHora || ''));

          let ultimaDesc = '';
          if (allMovimentos.length > 0) {
            const ult = allMovimentos[0];
            ultimaDesc = ult.nome;
            if (ult.complementos?.length > 0) {
              const compTexts = ult.complementos.map(c => c.valor || c.descricao || c.nome).filter(Boolean);
              if (compTexts.length > 0) ultimaDesc += ' - ' + compTexts.join(', ');
            }
            if (ult.grau && ult.grau !== 'G1') ultimaDesc += ` [${ult.grau}]`;
          }

          resolve({
            found: true,
            tribunal: bestHit.tribunal,
            grau: bestHit.grau,
            classe: bestHit.classe?.nome,
            orgaoJulgador: bestHit.orgaoJulgador?.nome,
            dataAjuizamento: formatDate(bestHit.dataAjuizamento),
            ultimaAtualizacaoDataJud: bestHit.dataHoraUltimaAtualizacao,
            totalMovimentos: allMovimentos.length,
            ultimaMovimentacao: allMovimentos.length > 0 ? {
              data: allMovimentos[0].data,
              descricao: ultimaDesc
            } : null,
            movimentosRecentes: allMovimentos.slice(0, 10).map(m => ({
              data: m.data,
              descricao: m.nome + (m.complementos?.length > 0 ? ' - ' + m.complementos.map(c => c.valor || c.nome).filter(Boolean).join(', ') : ''),
              grau: m.grau
            }))
          });
        } catch (e) {
          resolve({ found: false, error: e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ found: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ found: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function queryTST(numeroLimpo) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      query: { match: { numeroProcesso: numeroLimpo } },
      size: 3
    });
    const options = {
      hostname: 'api-publica.datajud.cnj.jus.br',
      path: '/api_publica_tst/_search',
      method: 'POST',
      headers: {
        'Authorization': `ApiKey ${API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 15000
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const hits = j.hits?.hits || [];
          if (hits.length > 0) {
            const src = hits[0]._source;
            const movs = (src.movimentos || []).sort((a, b) => (b.dataHora || '').localeCompare(a.dataHora || ''));
            resolve({
              found: true, grau: src.grau, totalMovimentos: movs.length,
              ultimaMov: movs[0] ? { data: formatDate(movs[0].dataHora), nome: movs[0].nome } : null
            });
          } else {
            resolve({ found: false });
          }
        } catch (e) { resolve({ found: false }); }
      });
    });
    req.on('error', () => resolve({ found: false }));
    req.on('timeout', () => { req.destroy(); resolve({ found: false }); });
    req.write(body);
    req.end();
  });
}

// === UPDATE FUNCTION ===
async function runUpdate(source = 'manual') {
  if (updateState.running) {
    return { error: 'Atualização já em andamento', progress: updateState.progress, total: updateState.total };
  }

  updateState.running = true;
  updateState.progress = 0;
  updateState.log = [];

  const logMsg = (msg) => {
    updateState.log.push({ time: new Date().toISOString(), msg });
    console.log(`[UPDATE] ${msg}`);
  };

  try {
    logMsg(`Iniciando atualização (fonte: ${source})`);

    const rawData = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(rawData);
    const processos = data.processos;
    updateState.total = processos.length;

    // Backup
    const backupFile = DATA_FILE.replace('.json', `_backup_${new Date().toISOString().substring(0, 10)}.json`);
    safeWriteFile(backupFile, rawData);
    logMsg(`Backup: ${path.basename(backupFile)}`);

    let found = 0, notFound = 0, errors = 0, updated = 0;
    const changes = [];

    for (let i = 0; i < processos.length; i++) {
      const p = processos[i];
      const numero = cleanNumero(p.numero);
      updateState.progress = i + 1;
      updateState.currentProcess = p.reclamante;

      if (!numero || numero.length < 15) {
        logMsg(`#${p.id} ${p.reclamante} -> NUMERO INVALIDO`);
        errors++;
        continue;
      }

      const result = await queryDataJud(numero, 'trt2');

      if (result.found) {
        found++;
        const change = {
          id: p.id, reclamante: p.reclamante, numero: p.numero,
          datajud: {
            totalMovimentos: result.totalMovimentos,
            ultimaMovimentacao: result.ultimaMovimentacao,
            ultimaAtualizacaoDataJud: result.ultimaAtualizacaoDataJud,
            movimentosRecentes: result.movimentosRecentes
          },
          mudancas: []
        };

        const newUltimaMov = result.ultimaMovimentacao;
        if (newUltimaMov?.data) {
          const currentDate = p.ultima_movimentacao?.data || '1900-01-01';
          if (newUltimaMov.data > currentDate) {
            change.mudancas.push({
              campo: 'ultima_movimentacao',
              anterior: p.ultima_movimentacao,
              novo: newUltimaMov
            });
            p.ultima_movimentacao_datajud = newUltimaMov;
            updated++;
            logMsg(`#${p.id} ${p.reclamante} -> ATUALIZADO: ${newUltimaMov.data}`);
          } else {
            logMsg(`#${p.id} ${p.reclamante} -> OK (${result.totalMovimentos} movs)`);
          }
        }

        p.datajud_ultima_verificacao = new Date().toISOString();
        p.datajud_total_movimentos = result.totalMovimentos;
        p.datajud_movimentos_recentes = result.movimentosRecentes;
        changes.push(change);
      } else if (result.error) {
        logMsg(`#${p.id} ${p.reclamante} -> ERRO: ${result.error}`);
        errors++;
      } else {
        const tstResult = await queryTST(numero);
        if (tstResult.found) {
          found++;
          p.datajud_ultima_verificacao = new Date().toISOString();
          p.datajud_tst = true;
          logMsg(`#${p.id} ${p.reclamante} -> TST (${tstResult.totalMovimentos} movs)`);
        } else {
          notFound++;
          logMsg(`#${p.id} ${p.reclamante} -> NAO ENCONTRADO`);
        }
      }

      if (i < processos.length - 1) await sleep(DELAY_MS);
    }

    data.metadata.ultima_atualizacao_datajud = new Date().toISOString();
    data.metadata.processos_encontrados_datajud = found;
    data.metadata.processos_nao_encontrados_datajud = notFound;
    safeWriteFile(DATA_FILE, JSON.stringify(data, null, 2));

    const reportFile = path.join(__dirname, `relatorio_atualizacao_${new Date().toISOString().substring(0, 10)}.json`);
    const report = {
      data_execucao: new Date().toISOString(),
      fonte: source,
      resumo: { total_processos: processos.length, encontrados: found, nao_encontrados: notFound, erros: errors, atualizados_com_novas_movimentacoes: updated },
      detalhes: changes
    };
    safeWriteFile(reportFile, JSON.stringify(report, null, 2));

    const result = {
      success: true,
      data_execucao: new Date().toISOString(),
      fonte: source,
      resumo: report.resumo,
      processos_atualizados: changes.filter(c => c.mudancas.length > 0).map(c => ({
        id: c.id, reclamante: c.reclamante,
        nova_movimentacao: c.datajud.ultimaMovimentacao
      }))
    };

    updateState.lastUpdate = new Date().toISOString();
    updateState.lastResult = result;
    logMsg(`Concluido: ${found} encontrados, ${updated} atualizados, ${notFound} nao encontrados, ${errors} erros`);

    return result;
  } catch (e) {
    logMsg(`ERRO FATAL: ${e.message}`);
    return { error: e.message };
  } finally {
    updateState.running = false;
    updateState.progress = 0;
    updateState.currentProcess = '';
  }
}

// === MIDDLEWARE ===
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// === API ROUTES ===

// Status da atualização (polling)
app.get('/api/status', (req, res) => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const processos = data.processos;

  // Load Comunica PJe cache
  let comunicaCache = {};
  if (fs.existsSync(COMUNICA_CACHE_FILE)) {
    try { comunicaCache = JSON.parse(fs.readFileSync(COMUNICA_CACHE_FILE, 'utf-8')); } catch(e) {}
  }

  // Build process summary
  const resumo = processos.map(p => {
    const datajudMov = p.ultima_movimentacao_datajud || p.datajud_movimentos_recentes?.[0] || null;
    const localMov = p.ultima_movimentacao;

    // Get Comunica PJe data (real-time)
    const comunica = comunicaCache[p.id] || null;
    const comunicacoes = comunica?.comunicacoes || [];
    const ultimaComunicacao = comunicacoes.length > 0 ? comunicacoes[0] : null;

    // Determine action based on process state
    let acao = '';
    let acaoCor = '';
    const fase = (p.fase || '').toLowerCase();
    const risco = (p.risco || '').toLowerCase();
    const prioridade = (p.prioridade || '').toLowerCase();

    if (p.proxima_audiencia) {
      const audiData = typeof p.proxima_audiencia === 'object' ? p.proxima_audiencia.data : p.proxima_audiencia;
      acao = `AUDIENCIA AGENDADA: ${audiData}`;
      acaoCor = 'vermelho';
    } else if (fase.includes('execu')) {
      acao = 'EM EXECUCAO - Verificar prazos e bloqueios';
      acaoCor = 'vermelho';
    } else if (p.desconsideracao_pj_burlington || p.desconsideracao_pj_frramos) {
      acao = 'DESC. PJ ATIVA - Monitorar bloqueios patrimoniais';
      acaoCor = 'vermelho';
    } else if (p.pedido_bloqueio_conta_pj || p.pedido_bloqueio_conta_socios) {
      acao = 'RISCO BLOQUEIO BANCARIO - Negociar preventivamente';
      acaoCor = 'vermelho';
    } else if (p.burlington_revel) {
      acao = 'REVEL - Avaliar acao rescisoria';
      acaoCor = 'vermelho';
    } else if (prioridade.includes('crit') || prioridade.includes('maxim') || prioridade.includes('urgent')) {
      acao = p.acao_sugerida || 'PRIORIDADE CRITICA - Acao imediata necessaria';
      acaoCor = 'vermelho';
    } else if (prioridade.includes('alta')) {
      acao = p.acao_sugerida || 'PRIORIDADE ALTA - Monitorar semanalmente';
      acaoCor = 'laranja';
    } else if (fase.includes('recurso') || fase.includes('agravo')) {
      acao = 'Aguardar julgamento do recurso';
      acaoCor = 'azul';
    } else if (p.causa_ganha_burlington) {
      acao = 'Causa GANHA - Monitorar transitado em julgado';
      acaoCor = 'verde';
    } else if (p.extinto_inercia_reclamante) {
      acao = 'EXTINTO por inercia do reclamante';
      acaoCor = 'verde';
    } else if (fase.includes('acordo')) {
      acao = 'Em ACORDO - Monitorar pagamento/cumprimento';
      acaoCor = 'azul';
    } else {
      acao = p.acao_sugerida || 'Acompanhar movimentacoes';
      acaoCor = 'cinza';
    }

    // Build defensive strategy
    let estrategia = [];
    if (p.desconsideracao_pj_burlington) estrategia.push('URGENTE: Desconsideracao PJ Burlington deferida. Patrimonio pessoal de Raphael e Brassplate em risco direto. Avaliar Agravo de Peticao imediatamente. Verificar se imoveis estao protegidos por bem de familia.');
    if (p.desconsideracao_pj_frramos) estrategia.push('URGENTE: Desconsideracao PJ FRRamos deferida. Patrimonio pessoal de Fernanda em risco. Interpor recurso imediato. Verificar regime de bens e protecao patrimonial.');
    if (p.pedido_bloqueio_conta_pj) estrategia.push('BLOQUEIO PJ: Risco SISBAJUD. Manter saldo minimo nas contas PJ. Considerar deposito judicial para evitar constricao.');
    if (p.pedido_bloqueio_conta_socios) estrategia.push('BLOQUEIO SOCIOS: Risco de bloqueio nas contas pessoais de Raphael e Fernanda via SISBAJUD. Antecipar defesa.');
    if (p.pedido_automovel) estrategia.push('PENHORA VEICULO: Arguir impenhorabilidade - ferramenta de trabalho (art. 833, V CPC) ou bem de familia.');
    if (p.pedido_imovel_burlington) estrategia.push('PENHORA IMOVEL BURLINGTON: Arguir bem de familia (Lei 8.009/90). Se for sede, arguir impenhorabilidade.');
    if (p.pedido_imovel_frramos) estrategia.push('PENHORA IMOVEL FRRAMOS: Arguir bem de familia de Fernanda (Lei 8.009/90). Entidade familiar protegida.');
    if (p.burlington_revel) estrategia.push('REVELIA: Burlington REVEL - confissao ficta. Avaliar acao rescisoria (art. 966 CPC) se sentenca transitou. Verificar se houve vicio de citacao.');
    if (p.grupo_economico_reconhecido) estrategia.push('GRUPO ECONOMICO: Reconhecido - todas as empresas respondem solidariamente. Focar em demonstrar autonomia entre Burlington e FRRamos.');
    if (fase.includes('execu')) estrategia.push('EXECUCAO: Fase critica. Opcoes: (1) Parcelamento art. 916 CPC, (2) Excepcao de pre-executividade para valores indevidos, (3) Embargos a execucao para discutir calculos, (4) Acordo parcelado.');
    if (p.proxima_audiencia) estrategia.push('AUDIENCIA PROXIMA: Preparar carta de preposicao, documentos e testemunhas. Verificar tipo (conciliacao/instrucao) e adaptar estrategia.');
    if (p.causa_ganha_burlington) estrategia.push('POSITIVO: Causa ganha para Burlington. Monitorar transito em julgado.');
    if (p.causa_ganha_frramos) estrategia.push('POSITIVO: FRRamos com causa ganha/excluida. Manter monitorizacao.');
    if (p.extinto_inercia_reclamante) estrategia.push('FAVORAVEL: Extinto por inercia do reclamante. Arquivamento definitivo.');

    if (estrategia.length === 0) {
      if (risco.includes('crit') || risco.includes('alt')) {
        estrategia.push('Risco ' + p.risco + ': Monitorar semanalmente. Priorizar defesa tecnica. Considerar negociacao se valor for viavel para parcelamento.');
      } else {
        estrategia.push('Acompanhar prazos processuais. Manter defesa em dia. Sem riscos patrimoniais imediatos identificados.');
      }
    }

    // Always add general protection note
    estrategia.push('PROTECAO PATRIMONIAL: Imoveis residenciais de Raphael e Fernanda sao protegidos como bem de familia (Lei 8.009/90). Veiculos de uso pessoal/trabalho podem ser arguidos como impenhoraveis. Manter planejamento patrimonial preventivo.');

    // Estimate prazo
    let prazo = null;
    let prazoAlerta = '';
    if (p.proxima_audiencia) {
      const ad = typeof p.proxima_audiencia === 'object' ? p.proxima_audiencia.data : String(p.proxima_audiencia);
      prazo = ad;
      prazoAlerta = 'AUDIENCIA em ' + ad;
    } else if (fase.includes('execu')) {
      prazo = 'Verificar intimacao';
      prazoAlerta = 'Em execucao - verificar se ha intimacao pendente para pagamento (48h apos intimacao via SISBAJUD)';
    } else if (datajudMov?.data) {
      // Estimate next deadline based on last movement
      const lastDate = new Date(datajudMov.data);
      const desc = (datajudMov.descricao || '').toLowerCase();
      if (desc.includes('intimacao') || desc.includes('publicacao') || desc.includes('diario')) {
        const deadline = new Date(lastDate);
        deadline.setDate(deadline.getDate() + 8); // 8 dias uteis ~ 12 corridos
        prazo = deadline.toISOString().substring(0,10);
        prazoAlerta = 'Prazo estimado: ~8 dias uteis apos publicacao em ' + datajudMov.data;
      } else if (desc.includes('sentenca') || desc.includes('decisao')) {
        const deadline = new Date(lastDate);
        deadline.setDate(deadline.getDate() + 8);
        prazo = deadline.toISOString().substring(0,10);
        prazoAlerta = 'Prazo para recurso: ~8 dias uteis apos intimacao da sentenca';
      } else if (desc.includes('despacho')) {
        prazoAlerta = 'Verificar teor do despacho - pode conter prazo para cumprimento';
      }
    }

    const result = {
      id: p.id,
      reclamante: p.reclamante,
      numero: p.numero,
      tipo: p.tipo,
      grau: p.grau,
      advogado_reclamante: p.advogado_reclamante,
      vara: p.vara,
      tribunal: p.tribunal,
      cidade: p.cidade,
      data_autuacao: p.data_autuacao,
      status: p.status,
      fase: p.fase,
      risco: p.risco,
      prioridade: p.prioridade,
      valor_causa: p.valor_causa,
      valor_condenacao: p.valor_condenacao,
      valor_acordo: p.valor_acordo || null,
      valor_bloqueado: p.valor_bloqueado || null,
      valor_liquido_execucao: p.valor_liquido_execucao || null,
      resultado_burlington: p.resultado_burlington,
      resultado_frramos: p.resultado_frramos,
      envolve_frramos: p.envolve_frramos,
      frramos_condenada: p.frramos_condenada,
      grupo_economico_reconhecido: p.grupo_economico_reconhecido,
      desconsideracao_pj_burlington: p.desconsideracao_pj_burlington,
      desconsideracao_pj_frramos: p.desconsideracao_pj_frramos,
      defesa_aceita: p.defesa_aceita,
      burlington_revel: p.burlington_revel,
      pedido_bloqueio_conta_pj: p.pedido_bloqueio_conta_pj,
      pedido_bloqueio_conta_socios: p.pedido_bloqueio_conta_socios,
      pedido_automovel: p.pedido_automovel,
      pedido_imovel_frramos: p.pedido_imovel_frramos,
      pedido_imovel_burlington: p.pedido_imovel_burlington,
      causa_ganha_burlington: p.causa_ganha_burlington,
      causa_ganha_frramos: p.causa_ganha_frramos,
      extinto_inercia_reclamante: p.extinto_inercia_reclamante,
      proxima_audiencia: p.proxima_audiencia,
      ultima_mov_local: localMov,
      ultima_mov_datajud: datajudMov,
      datajud_total_movimentos: p.datajud_total_movimentos || 0,
      datajud_ultima_verificacao: p.datajud_ultima_verificacao || null,
      acao,
      acaoCor,
      estrategia: estrategia.slice(0, 2).map(s => s.substring(0, 120)),
      prazo,
      prazoAlerta,
      acao_sugerida: (p.acao_sugerida || '').substring(0, 150),
      comunica_total: comunica?.total_comunicacoes || 0,
      comunica_ultima: ultimaComunicacao ? {
        data: ultimaComunicacao.data,
        tipo: ultimaComunicacao.tipo,
        orgao: ultimaComunicacao.orgao,
        decisao: ultimaComunicacao.parsed?.tipo_decisao || '',
        urgente: ultimaComunicacao.parsed?.urgente || false,
        prazo_dias: ultimaComunicacao.parsed?.prazo_dias || null
      } : null,
      comunica_recente_data: comunicacoes.length > 0 ? comunicacoes[0].data : null,
      comunica_recente_decisao: comunicacoes.length > 0 ? (comunicacoes[0].parsed?.tipo_decisao || '') : ''
    };

    // Override prazo with Comunica PJe real-time data if available
    if (ultimaComunicacao?.parsed?.prazo_dias && ultimaComunicacao.data) {
      const prazoReal = calcPrazoFinal(ultimaComunicacao.data, ultimaComunicacao.parsed.prazo_dias);
      if (prazoReal) {
        result.prazo = prazoReal;
        result.prazoAlerta = 'TEMPO REAL (Comunica PJe): ' + ultimaComunicacao.parsed.prazo_descricao + ' | Publicado: ' + ultimaComunicacao.data;
        if (ultimaComunicacao.parsed.urgente) {
          result.acaoCor = 'vermelho';
          result.acao = ultimaComunicacao.parsed.tipo_decisao + ' - PRAZO: ' + prazoReal;
        }
      }
    }
    // If comunica has more recent data than DataJud, flag it
    if (ultimaComunicacao?.data && datajudMov?.data && ultimaComunicacao.data > datajudMov.data) {
      result.comunica_mais_recente = true;
    }

    return result;
  });

  res.json({
    updateState: {
      running: updateState.running,
      progress: updateState.progress,
      total: updateState.total,
      currentProcess: updateState.currentProcess,
      lastUpdate: updateState.lastUpdate || data.metadata.ultima_atualizacao_datajud,
      lastResult: updateState.lastResult
    },
    metadata: data.metadata,
    processos: resumo
  });
});

// Iniciar atualização
app.post('/api/atualizar', async (req, res) => {
  if (updateState.running) {
    return res.json({ error: 'Atualização já em andamento', running: true, progress: updateState.progress, total: updateState.total });
  }
  // Start async - respond immediately
  res.json({ started: true, message: 'Atualização iniciada' });
  runUpdate('dashboard-manual');
});

// Progress (SSE)
app.get('/api/progress', (req, res) => {
  res.json({
    running: updateState.running,
    progress: updateState.progress,
    total: updateState.total,
    currentProcess: updateState.currentProcess,
    log: updateState.log.slice(-20)
  });
});

// Processos completos
app.get('/api/processos', (req, res) => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  res.json(data);
});

// Processo completo (para popup - lazy load)
app.get('/api/processo/:id', (req, res) => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const p = data.processos.find(x => x.id === Number(req.params.id));
  if (!p) return res.json({ error: 'Processo nao encontrado' });

  let comunicaCache = {};
  if (fs.existsSync(COMUNICA_CACHE_FILE)) {
    try { comunicaCache = JSON.parse(fs.readFileSync(COMUNICA_CACHE_FILE, 'utf-8')); } catch(e) {}
  }
  const comunica = comunicaCache[p.id];
  const comunicacoes = comunica?.comunicacoes || [];

  // Build full estrategia
  const fase = (p.fase || '').toLowerCase();
  const risco = (p.risco || '').toLowerCase();
  let estrategia = [];
  if (p.desconsideracao_pj_burlington) estrategia.push('URGENTE: Desconsideracao PJ Burlington deferida. Patrimonio pessoal de Raphael e Brassplate em risco direto. Avaliar Agravo de Peticao imediatamente. Verificar se imoveis estao protegidos por bem de familia.');
  if (p.desconsideracao_pj_frramos) estrategia.push('URGENTE: Desconsideracao PJ FRRamos deferida. Patrimonio pessoal de Fernanda em risco. Interpor recurso imediato. Verificar regime de bens e protecao patrimonial.');
  if (p.pedido_bloqueio_conta_pj) estrategia.push('BLOQUEIO PJ: Risco SISBAJUD. Manter saldo minimo nas contas PJ. Considerar deposito judicial para evitar constricao.');
  if (p.pedido_bloqueio_conta_socios) estrategia.push('BLOQUEIO SOCIOS: Risco de bloqueio nas contas pessoais de Raphael e Fernanda via SISBAJUD. Antecipar defesa.');
  if (p.pedido_automovel) estrategia.push('PENHORA VEICULO: Arguir impenhorabilidade - ferramenta de trabalho (art. 833, V CPC) ou bem de familia.');
  if (p.pedido_imovel_burlington) estrategia.push('PENHORA IMOVEL BURLINGTON: Arguir bem de familia (Lei 8.009/90). Se for sede, arguir impenhorabilidade.');
  if (p.pedido_imovel_frramos) estrategia.push('PENHORA IMOVEL FRRAMOS: Arguir bem de familia de Fernanda (Lei 8.009/90). Entidade familiar protegida.');
  if (p.burlington_revel) estrategia.push('REVELIA: Burlington REVEL - confissao ficta. Avaliar acao rescisoria (art. 966 CPC) se sentenca transitou.');
  if (p.grupo_economico_reconhecido) estrategia.push('GRUPO ECONOMICO: Reconhecido - todas as empresas respondem solidariamente.');
  if (fase.includes('execu')) estrategia.push('EXECUCAO: Fase critica. Opcoes: (1) Parcelamento art. 916 CPC, (2) Excepcao de pre-executividade, (3) Embargos a execucao, (4) Acordo parcelado.');
  if (p.proxima_audiencia) estrategia.push('AUDIENCIA PROXIMA: Preparar carta de preposicao, documentos e testemunhas.');
  if (p.causa_ganha_burlington) estrategia.push('POSITIVO: Causa ganha para Burlington. Monitorar transito em julgado.');
  if (p.causa_ganha_frramos) estrategia.push('POSITIVO: FRRamos com causa ganha/excluida.');
  if (p.extinto_inercia_reclamante) estrategia.push('FAVORAVEL: Extinto por inercia do reclamante.');
  if (estrategia.length === 0) estrategia.push('Acompanhar prazos processuais. Sem riscos patrimoniais imediatos.');
  estrategia.push('PROTECAO PATRIMONIAL: Imoveis residenciais de Raphael e Fernanda sao protegidos como bem de familia (Lei 8.009/90). Veiculos de uso pessoal/trabalho podem ser arguidos como impenhoraveis.');

  res.json({
    ...p,
    estrategia,
    comunicacoes: comunicacoes.slice(0, 10).map(c => ({
      data: c.data, tipo: c.tipo, orgao: c.orgao, link: c.link,
      parsed: c.parsed, destinatarios: c.destinatarios
    })),
    comunica_total: comunica?.total_comunicacoes || 0,
    comunica_ultima_verificacao: comunica?.ultima_verificacao || null
  });
});

// Comunicacoes PJe (tempo real)
app.get('/api/comunicacoes', (req, res) => {
  let cache = {};
  if (fs.existsSync(COMUNICA_CACHE_FILE)) {
    try { cache = JSON.parse(fs.readFileSync(COMUNICA_CACHE_FILE, 'utf-8')); } catch(e) {}
  }
  res.json(cache);
});

// Comunicacoes de um processo especifico (tempo real - direto da API)
app.get('/api/comunicacoes/:id', async (req, res) => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const p = data.processos.find(x => x.id === Number(req.params.id));
  if (!p) return res.json({ error: 'Processo nao encontrado' });
  const num = (p.numero || '').replace(/[^0-9]/g, '');
  const result = await queryComunicaPJe(num);
  if (result.success) {
    const items = result.items.map(it => ({
      id: it.id, data: it.data_disponibilizacao, tipo: it.tipoComunicacao,
      orgao: it.nomeOrgao, tribunal: it.siglaTribunal, link: it.link,
      destinatarios: (it.destinatarios||[]).map(d => d.nome),
      parsed: parseIntimacao(it.texto),
      texto_completo: it.texto
    }));
    res.json({ success: true, count: result.count, comunicacoes: items });
  } else {
    res.json({ success: false, error: result.error });
  }
});

// Processo FULL - busca tudo em tempo real (DataJud + Comunica PJe)
app.get('/api/processo/:id/full', async (req, res) => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const p = data.processos.find(x => x.id === Number(req.params.id));
  if (!p) return res.json({ error: 'Processo nao encontrado' });

  const num = (p.numero || '').replace(/[^0-9]/g, '');
  const tribunal = (p.tribunal || 'TRT-2').toLowerCase().replace('-','');

  // Fetch DataJud (ALL movements - size 20 to get max)
  const datajudPromise = new Promise((resolve) => {
    const body = JSON.stringify({ query: { match: { numeroProcesso: num } }, size: 20 });
    const options = {
      hostname: 'api-publica.datajud.cnj.jus.br',
      path: '/api_publica_' + tribunal + '/_search',
      method: 'POST',
      headers: { 'Authorization': 'ApiKey ' + API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000
    };
    const req2 = https.request(options, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (r.statusCode !== 200) { resolve({ movimentos: [], assuntos: [], partes: [] }); return; }
          const hits = j.hits?.hits || [];
          let movs = [], assuntos = [], partes = [], sentencas = [];
          let grauInfo = {};
          hits.forEach(hit => {
            const src = hit._source;
            grauInfo[src.grau || 'G1'] = {
              classe: src.classe?.nome, orgao: src.orgaoJulgador?.nome,
              sistema: src.sistemaProcessual?.nome, formato: src.formato?.nome,
              dataAjuizamento: src.dataAjuizamento, nivelSigilo: src.nivelSigilo
            };
            (src.movimentos || []).forEach(m => {
              const comps = (m.complementosTabelados || []).map(c => ({ nome: c.nome, valor: c.valor, descricao: c.descricao }));
              const isSentenca = m.nome && (m.nome.toLowerCase().includes('senten') || m.nome.toLowerCase().includes('acordao') || m.nome.toLowerCase().includes('despacho') || m.nome.toLowerCase().includes('decisão') || m.nome.toLowerCase().includes('decisao'));
              movs.push({
                data: formatDate(m.dataHora), dataHora: m.dataHora, nome: m.nome, codigo: m.codigo,
                grau: src.grau, orgao: src.orgaoJulgador?.nome, complementos: comps, isSentenca
              });
            });
            (src.assuntos || []).forEach(a => { if (!assuntos.find(x => x.codigo === a.codigo)) assuntos.push({ nome: a.nome, codigo: a.codigo }); });
            (src.partes || []).forEach(pt => { if (!partes.find(x => x.nome === pt.nome)) partes.push({ nome: pt.nome, tipo: pt.tipo, advogados: (pt.advogados||[]).map(a => a.nome) }); });
          });
          movs.sort((a, b) => (b.dataHora || '').localeCompare(a.dataHora || ''));
          resolve({ movimentos: movs, assuntos, partes, grauInfo });
        } catch(e) { resolve({ movimentos: [], assuntos: [], partes: [] }); }
      });
    });
    req2.on('error', () => resolve({ movimentos: [], assuntos: [], partes: [] }));
    req2.on('timeout', () => { req2.destroy(); resolve({ movimentos: [], assuntos: [], partes: [] }); });
    req2.write(body); req2.end();
  });

  // Also try TST if applicable
  const tstPromise = (p.grau && p.grau.includes('TST')) || (p.tipo && p.tipo.includes('AIRR')) ? new Promise((resolve) => {
    const body = JSON.stringify({ query: { match: { numeroProcesso: num } }, size: 5 });
    const options = {
      hostname: 'api-publica.datajud.cnj.jus.br', path: '/api_publica_tst/_search', method: 'POST',
      headers: { 'Authorization': 'ApiKey ' + API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000
    };
    const req2 = https.request(options, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const j = JSON.parse(d);
          const hits = j.hits?.hits || [];
          let movs = [];
          hits.forEach(hit => {
            (hit._source.movimentos || []).forEach(m => {
              movs.push({ data: formatDate(m.dataHora), dataHora: m.dataHora, nome: m.nome, codigo: m.codigo, grau: 'TST', orgao: hit._source.orgaoJulgador?.nome, complementos: (m.complementosTabelados||[]).map(c=>({nome:c.nome,valor:c.valor,descricao:c.descricao})) });
            });
          });
          resolve(movs);
        } catch(e) { resolve([]); }
      });
    });
    req2.on('error', () => resolve([]));
    req2.on('timeout', () => { req2.destroy(); resolve([]); });
    req2.write(body); req2.end();
  }) : Promise.resolve([]);

  // Fetch ALL comunicacoes
  const comunicaPromise = queryComunicaPJe(num);

  // Wait for all
  const [datajud, tstMovs, comunica] = await Promise.all([datajudPromise, tstPromise, comunicaPromise]);

  // Merge TST movimentos
  if (tstMovs.length > 0) {
    datajud.movimentos = [...datajud.movimentos, ...tstMovs].sort((a,b) => (b.dataHora||'').localeCompare(a.dataHora||''));
  }

  // Parse comunicacoes
  const comunicacoes = comunica.success ? comunica.items.map(it => ({
    id: it.id, data: it.data_disponibilizacao, tipo: it.tipoComunicacao,
    orgao: it.nomeOrgao, tribunal: it.siglaTribunal, link: it.link,
    destinatarios: (it.destinatarios||[]).map(d => d.nome),
    parsed: parseIntimacao(it.texto),
    texto_completo: it.texto
  })) : [];

  res.json({
    ...p,
    full: true,
    datajud_movimentos_all: datajud.movimentos,
    datajud_assuntos: datajud.assuntos,
    datajud_partes: datajud.partes,
    datajud_grau_info: datajud.grauInfo,
    comunicacoes_all: comunicacoes,
    comunica_total: comunica.success ? comunica.count : (p.comunica_total || 0),
    fetched_at: new Date().toISOString()
  });
});

// Atualizar comunicacoes de todos
app.post('/api/comunicacoes/atualizar', async (req, res) => {
  res.json({ started: true, message: 'Atualizacao Comunica PJe iniciada (demora ~4 min para 64 processos)' });
  runComunicaUpdate('dashboard-manual');
});

// === SERVE DASHBOARD ===
app.get('/', (req, res) => {
  res.send(generateDashboardHTML());
});

// === ASTREA COPY ===
app.get('/astrea', (req, res) => {
  res.send(generateAstreaHTML());
});

// === GENERATE DASHBOARD ===
function generateDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Burlington Legal - Dashboard + DataJud</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;line-height:1.5}
.ctn{max-width:1600px;margin:0 auto;padding:16px;padding-top:70px}
.nav{position:fixed;top:0;left:0;right:0;z-index:900;background:rgba(13,17,23,.95);backdrop-filter:blur(12px);border-bottom:1px solid #30363d;padding:0 20px;display:flex;align-items:center;gap:0;height:56px}
.nav-brand{font-weight:700;font-size:.95rem;color:#fff;white-space:nowrap;padding-right:20px;border-right:1px solid #30363d;margin-right:8px}
.nav a{color:#8b949e;text-decoration:none;font-size:.8rem;padding:8px 14px;border-radius:6px;transition:all .15s;white-space:nowrap;cursor:pointer}
.nav a:hover,.nav a.nav-ac{color:#fff;background:rgba(88,166,255,.12)}
.nav a.nav-ac{color:#58a6ff;font-weight:600}

/* MODAL POPUP */
.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:1000;backdrop-filter:blur(4px);overflow-y:auto;padding:20px}
.modal-overlay.show{display:flex;justify-content:center;align-items:flex-start}
.modal{background:#161b22;border:1px solid #30363d;border-radius:16px;width:100%;max-width:1000px;margin:40px auto;animation:modalIn .3s ease;overflow:hidden}
@keyframes modalIn{from{opacity:0;transform:translateY(-20px)}to{opacity:1;transform:translateY(0)}}
.modal-hdr{background:linear-gradient(135deg,#1a2744,#0d1117);padding:20px 28px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.modal-hdr h2{font-size:1.15rem;color:#fff;flex:1}
.modal-hdr .badges{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.modal-close{background:#21262d;border:1px solid #30363d;color:#8b949e;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:.85rem;transition:all .15s}
.modal-close:hover{background:#f85149;color:#fff;border-color:#f85149}
.btn-full{background:linear-gradient(135deg,#238636,#2ea043);border:1px solid #3fb950;color:#fff;padding:8px 18px;border-radius:8px;cursor:pointer;font-size:.82rem;font-weight:700;transition:all .2s;display:inline-flex;align-items:center;gap:6px}
.btn-full:hover{background:linear-gradient(135deg,#2ea043,#3fb950);transform:translateY(-1px);box-shadow:0 4px 12px rgba(63,185,80,.3)}
.btn-full.loading{opacity:.7;pointer-events:none}
.modal-body{padding:24px 28px;max-height:75vh;overflow-y:auto}

/* Full view */
.full-section{margin-bottom:20px;border:1px solid #30363d;border-radius:12px;overflow:hidden}
.full-section-hdr{background:#1c2333;padding:12px 18px;font-size:.88rem;font-weight:700;display:flex;justify-content:space-between;align-items:center;cursor:pointer}
.full-section-hdr:hover{background:#242d40}
.full-section-body{padding:16px 18px;max-height:500px;overflow-y:auto}
.full-mov{padding:10px 14px;border-bottom:1px solid #21262d;display:grid;grid-template-columns:100px 1fr;gap:12px;font-size:.82rem;transition:background .15s}
.full-mov:hover{background:rgba(88,166,255,.04)}
.full-mov:last-child{border-bottom:none}
.full-mov-date{color:#58a6ff;font-weight:600;white-space:nowrap}
.full-mov-desc{color:#e6edf3}
.full-mov-comp{color:#8b949e;font-size:.76rem;margin-top:3px}
.full-mov-grau{display:inline-block;background:rgba(188,140,255,.1);color:#d2a8ff;padding:1px 8px;border-radius:4px;font-size:.7rem;margin-left:6px}
.full-mov.sentenca{border-left:3px solid #f85149;background:rgba(248,81,73,.04)}
.full-mov.sentenca .full-mov-desc{color:#f85149;font-weight:600}
.full-intim{padding:14px 18px;border-bottom:1px solid #21262d;font-size:.82rem}
.full-intim:last-child{border-bottom:none}
.full-intim-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px}
.full-intim-texto{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:12px;font-size:.78rem;color:#8b949e;line-height:1.7;max-height:200px;overflow-y:auto;white-space:pre-wrap;margin-top:8px}
.full-parte{padding:8px 14px;border-bottom:1px solid #21262d;display:flex;justify-content:space-between;align-items:center;font-size:.82rem}
.full-parte:last-child{border-bottom:none}
.full-filter{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.full-filter button{background:#21262d;border:1px solid #30363d;color:#8b949e;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:.75rem;transition:all .15s}
.full-filter button:hover,.full-filter button.active{background:rgba(88,166,255,.15);color:#58a6ff;border-color:rgba(88,166,255,.3)}

/* Modal sections */
.m-section{margin-bottom:20px}
.m-section h3{font-size:.88rem;color:#58a6ff;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #21262d;text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:8px}
.m-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px 16px}
.m-field{padding:6px 0}
.m-field .lbl{font-size:.72rem;color:#8b949e;text-transform:uppercase;letter-spacing:.3px}
.m-field .val{font-size:.88rem;color:#e6edf3;font-weight:500}

/* Prazo box */
.prazo-box{background:rgba(248,81,73,.08);border:2px solid rgba(248,81,73,.3);border-radius:12px;padding:18px 22px;margin-bottom:16px}
.prazo-box.safe{background:rgba(63,185,80,.08);border-color:rgba(63,185,80,.3)}
.prazo-box h3{color:#f85149;margin-bottom:8px;border:none;padding:0}
.prazo-box.safe h3{color:#3fb950}
.prazo-box .prazo-date{font-size:1.3rem;font-weight:700;color:#f85149;margin-bottom:4px}
.prazo-box.safe .prazo-date{color:#3fb950}
.prazo-box .prazo-desc{font-size:.84rem;color:#ffa198}
.prazo-box.safe .prazo-desc{color:#7ee787}

/* Strategy box */
.strat-box{background:rgba(210,153,34,.06);border:1px solid rgba(210,153,34,.2);border-radius:12px;padding:18px 22px;margin-bottom:16px}
.strat-box h3{color:#d29922;border:none;padding:0;margin-bottom:10px}
.strat-item{background:rgba(0,0,0,.2);border-radius:8px;padding:12px 16px;margin-bottom:8px;font-size:.84rem;line-height:1.6;border-left:3px solid #d29922}
.strat-item.urgent{border-left-color:#f85149;background:rgba(248,81,73,.06)}
.strat-item.positive{border-left-color:#3fb950;background:rgba(63,185,80,.06)}

/* Alerts */
.alert-box{background:rgba(248,81,73,.06);border:1px solid rgba(248,81,73,.2);border-radius:10px;padding:14px 18px;margin-bottom:10px}
.alert-box .alert-title{color:#f85149;font-weight:700;font-size:.86rem;margin-bottom:6px}
.alert-box li{font-size:.82rem;padding:3px 0;color:#ffa198;list-style:none}

/* Timeline */
.tl{position:relative;padding-left:24px}
.tl::before{content:'';position:absolute;left:8px;top:4px;bottom:4px;width:2px;background:#30363d}
.tl-item{position:relative;margin-bottom:10px}
.tl-item::before{content:'';position:absolute;left:-20px;top:6px;width:10px;height:10px;border-radius:50%;background:#58a6ff;border:2px solid #161b22}
.tl-item:first-child::before{background:#3fb950}
.tl-item .tl-date{font-size:.73rem;color:#58a6ff;font-weight:600}
.tl-item .tl-desc{font-size:.8rem;color:#8b949e}
.tl-item .tl-grau{font-size:.68rem;color:#bc8cff;margin-left:6px}

/* Tags */
.tag-list{display:flex;flex-wrap:wrap;gap:5px}
.tag{background:#1c2333;border:1px solid #30363d;border-radius:6px;padding:3px 9px;font-size:.76rem;color:#8b949e}
.tag-r{color:#f85149;border-color:rgba(248,81,73,.3)}
.tag-g{color:#3fb950;border-color:rgba(63,185,80,.3)}

/* Values */
.val-big{font-size:1.4rem;font-weight:700}
.val-red{color:#f85149}
.val-orange{color:#d29922}
.val-green{color:#3fb950}

/* ACTION FEED */
.feed-panel{background:#161b22;border:1px solid #30363d;border-radius:16px;margin-bottom:20px;overflow:hidden}
.feed-hdr{background:linear-gradient(135deg,#1a2744 0%,#161b22 100%);padding:18px 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;cursor:pointer}
.feed-hdr:hover{background:linear-gradient(135deg,#1e2d50 0%,#1a2030 100%)}
.feed-hdr h2{font-size:1.05rem;color:#fff;display:flex;align-items:center;gap:10px}
.feed-hdr .feed-count{background:#f85149;color:#fff;padding:2px 10px;border-radius:20px;font-size:.78rem;font-weight:700}
.feed-hdr .feed-count.ok{background:#3fb950}
.feed-toggle{color:#8b949e;font-size:1.2rem;transition:transform .3s}
.feed-toggle.open{transform:rotate(180deg)}
.feed-body{padding:0 24px 20px;max-height:80vh;overflow-y:auto}
.feed-tabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid #30363d;padding-bottom:0;overflow-x:auto}
.feed-tab{padding:10px 18px;font-size:.82rem;color:#8b949e;cursor:pointer;border-bottom:3px solid transparent;transition:all .2s;white-space:nowrap;background:none;border-top:none;border-left:none;border-right:none;font-weight:500}
.feed-tab:hover{color:#e6edf3}
.feed-tab.active{color:#58a6ff;border-bottom-color:#58a6ff;font-weight:700}
.feed-tab .tab-badge{background:rgba(248,81,73,.2);color:#f85149;padding:1px 7px;border-radius:10px;font-size:.7rem;margin-left:5px}
.feed-pane{display:none}
.feed-pane.active{display:block}
.feed-item{display:flex;gap:14px;padding:14px 0;border-bottom:1px solid #21262d;align-items:flex-start;transition:background .15s;cursor:pointer;margin:0 -6px;padding-left:6px;padding-right:6px;border-radius:8px}
.feed-item:hover{background:rgba(88,166,255,.04)}
.feed-item:last-child{border-bottom:none}
.feed-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0}
.feed-icon.red{background:rgba(248,81,73,.12);color:#f85149}
.feed-icon.orange{background:rgba(210,153,34,.12);color:#d29922}
.feed-icon.blue{background:rgba(88,166,255,.12);color:#58a6ff}
.feed-icon.green{background:rgba(63,185,80,.12);color:#3fb950}
.feed-icon.purple{background:rgba(188,140,255,.12);color:#bc8cff}
.feed-content{flex:1;min-width:0}
.feed-title{font-size:.88rem;font-weight:600;color:#e6edf3;margin-bottom:3px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.feed-title .feed-id{color:#8b949e;font-weight:400;font-size:.78rem}
.feed-desc{font-size:.8rem;color:#8b949e;line-height:1.5}
.feed-meta{display:flex;gap:10px;margin-top:6px;flex-wrap:wrap;align-items:center}
.feed-date{font-size:.75rem;font-weight:600;padding:2px 8px;border-radius:4px}
.feed-date.recent{background:rgba(63,185,80,.12);color:#3fb950}
.feed-date.warning{background:rgba(210,153,34,.12);color:#d29922}
.feed-date.danger{background:rgba(248,81,73,.12);color:#f85149}
.feed-tag{font-size:.7rem;padding:2px 8px;border-radius:4px;background:rgba(139,148,158,.1);color:#8b949e}
.feed-prazo{font-size:.78rem;font-weight:700;color:#f85149;background:rgba(248,81,73,.08);padding:3px 10px;border-radius:6px}
.feed-empty{text-align:center;padding:40px;color:#484f58;font-size:.88rem}

/* PRAZOS TABLE */
.prazos-panel{background:#161b22;border:2px solid rgba(248,81,73,.2);border-radius:16px;margin-bottom:20px;overflow:hidden}
.prazos-hdr{background:linear-gradient(135deg,#2d1520 0%,#161b22 100%);padding:18px 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
.prazos-hdr h2{font-size:1.05rem;color:#f85149;display:flex;align-items:center;gap:10px}
.prazos-body{padding:0 24px 20px}
.prazos-table{width:100%;border-collapse:collapse;font-size:.82rem}
.prazos-table thead{position:sticky;top:0;z-index:5}
.prazos-table th{background:#1c2333;color:#8b949e;padding:10px 8px;text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #30363d}
.prazos-table td{padding:10px 8px;border-bottom:1px solid #21262d;vertical-align:top}
.prazos-table tbody tr{transition:all .15s;cursor:pointer}
.prazos-table tbody tr:hover{background:rgba(88,166,255,.06)}
.countdown{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;font-weight:700;font-size:.9rem;white-space:nowrap}
.countdown.vencido{background:rgba(248,81,73,.15);color:#f85149;border:1px solid rgba(248,81,73,.3);animation:blink 1.5s infinite}
.countdown.critico{background:rgba(248,81,73,.1);color:#f85149;border:1px solid rgba(248,81,73,.2)}
.countdown.alerta{background:rgba(210,153,34,.1);color:#d29922;border:1px solid rgba(210,153,34,.2)}
.countdown.ok{background:rgba(63,185,80,.08);color:#3fb950;border:1px solid rgba(63,185,80,.2)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.5}}
.peticao-box{background:rgba(188,140,255,.06);border:1px solid rgba(188,140,255,.15);border-radius:8px;padding:8px 12px;font-size:.78rem;color:#d2a8ff;line-height:1.5;max-width:400px}

@media(max-width:900px){.m-grid{grid-template-columns:1fr 1fr}.modal{margin:10px}}

/* HEADER */
.hdr{background:linear-gradient(135deg,#1a1f35 0%,#0f1923 50%,#0d1117 100%);border:1px solid #30363d;border-radius:16px;padding:28px 32px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px}
.hdr h1{font-size:1.7rem;color:#fff;margin-bottom:6px;background:linear-gradient(90deg,#58a6ff,#bc8cff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hdr .sub{font-size:.85rem;color:#8b949e;margin-bottom:2px}
.hdr .sub b{color:#e6edf3}
.dbg{display:inline-block;background:#58a6ff;color:#000;padding:3px 12px;border-radius:20px;font-weight:600;font-size:.8rem;margin-top:4px}
.dbg-g{background:#3fb950}

/* UPDATE PANEL */
.upd-panel{background:#161b22;border:1px solid #30363d;border-radius:16px;padding:24px;margin-bottom:20px;position:relative;overflow:hidden}
.upd-panel h2{font-size:1.1rem;color:#58a6ff;margin-bottom:16px;display:flex;align-items:center;gap:10px}
.upd-top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px;margin-bottom:20px}
.upd-info{display:flex;gap:20px;flex-wrap:wrap;align-items:center}
.upd-stat{text-align:center;background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:12px 18px;min-width:120px}
.upd-stat .n{font-size:1.6rem;font-weight:700;color:#58a6ff}
.upd-stat .l{font-size:.7rem;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
.upd-stat.st-g .n{color:#3fb950}
.upd-stat.st-r .n{color:#f85149}
.upd-stat.st-o .n{color:#d29922}

.btn-update{background:linear-gradient(135deg,#238636,#2ea043);color:#fff;border:none;padding:14px 32px;border-radius:12px;font-size:.95rem;font-weight:700;cursor:pointer;transition:all .2s;display:flex;align-items:center;gap:8px;white-space:nowrap}
.btn-update:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(46,160,67,.4)}
.btn-update:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
.btn-update.running{background:linear-gradient(135deg,#d29922,#e3b341);animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.7}}

/* PROGRESS BAR */
.prog-wrap{display:none;margin-bottom:16px}
.prog-wrap.show{display:block}
.prog-bar{height:8px;background:#21262d;border-radius:4px;overflow:hidden;margin-bottom:6px}
.prog-fill{height:100%;background:linear-gradient(90deg,#58a6ff,#3fb950);border-radius:4px;transition:width .3s;width:0%}
.prog-text{font-size:.78rem;color:#8b949e;display:flex;justify-content:space-between}

/* UPDATE TABLE */
.upd-table-wrap{max-height:700px;overflow-y:auto;border:1px solid #30363d;border-radius:10px}
.upd-table{width:100%;border-collapse:collapse;font-size:.82rem}
.upd-table thead{position:sticky;top:0;z-index:10}
.upd-table th{background:#1c2333;color:#8b949e;padding:10px 8px;text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #30363d;cursor:pointer;user-select:none;white-space:nowrap}
.upd-table th:hover{color:#58a6ff}
.upd-table td{padding:8px;border-bottom:1px solid #21262d;vertical-align:middle}
.upd-table tbody tr{transition:all .15s}
.upd-table tbody tr:hover{background:rgba(88,166,255,.06)}

/* Action badges */
.acao-badge{display:inline-block;padding:3px 10px;border-radius:6px;font-size:.72rem;font-weight:600;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acao-vermelho{background:rgba(248,81,73,.12);color:#f85149;border:1px solid rgba(248,81,73,.25)}
.acao-laranja{background:rgba(210,153,34,.12);color:#d29922;border:1px solid rgba(210,153,34,.25)}
.acao-azul{background:rgba(88,166,255,.12);color:#58a6ff;border:1px solid rgba(88,166,255,.25)}
.acao-verde{background:rgba(63,185,80,.12);color:#3fb950;border:1px solid rgba(63,185,80,.25)}
.acao-cinza{background:rgba(139,148,158,.1);color:#8b949e;border:1px solid rgba(139,148,158,.2)}

/* Risk/Priority badges */
.bg{display:inline-block;padding:2px 10px;border-radius:20px;font-size:.72rem;font-weight:600}
.bg-r{background:rgba(248,81,73,.15);color:#f85149}
.bg-o{background:rgba(210,153,34,.15);color:#d29922}
.bg-y{background:rgba(227,179,65,.15);color:#e3b341}
.bg-g{background:rgba(63,185,80,.15);color:#3fb950}
.bg-b{background:rgba(88,166,255,.15);color:#58a6ff}

/* Date highlighting */
.dt-recent{color:#3fb950;font-weight:600}
.dt-old{color:#d29922}
.dt-stale{color:#f85149}

/* CRON SECTION */
.cron-info{background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:14px 18px;margin-top:16px;font-size:.82rem;color:#8b949e}
.cron-info b{color:#58a6ff}
.cron-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.cron-dot.on{background:#3fb950;box-shadow:0 0 8px rgba(63,185,80,.5)}

/* LOG */
.log-panel{display:none;background:#0d1117;border:1px solid #30363d;border-radius:10px;margin-top:12px;max-height:200px;overflow-y:auto;padding:12px;font-family:'SF Mono',Consolas,monospace;font-size:.75rem;color:#8b949e}
.log-panel.show{display:block}
.log-entry{padding:2px 0;border-bottom:1px solid #161b22}
.log-entry .time{color:#484f58}

/* SEARCH */
.upd-search{background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:9px 14px;font-size:.85rem;width:300px;margin-bottom:12px}
.upd-search:focus{outline:none;border-color:#58a6ff;box-shadow:0 0 0 3px rgba(88,166,255,.15)}

/* FOOTER */
.footer{text-align:center;padding:30px;color:#484f58;font-size:.78rem;border-top:1px solid #21262d;margin-top:40px}
.footer a{color:#58a6ff;text-decoration:none}

/* BACK TO TOP */
.btt{position:fixed;bottom:24px;right:24px;width:44px;height:44px;border-radius:50%;background:#58a6ff;color:#000;border:none;font-size:1.2rem;cursor:pointer;display:none;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.4);z-index:100}
.btt.vis{display:flex}

@media(max-width:900px){
  .upd-info{flex-direction:column}
  .upd-top{flex-direction:column}
  .upd-search{width:100%}
  .hdr{flex-direction:column}
}
</style>
</head>
<body>

<!-- MODAL -->
<div class="modal-overlay" id="modalOverlay" onclick="if(event.target===this)closeModal()">
  <div class="modal" id="modalContent"></div>
</div>

<nav class="nav">
  <div class="nav-brand">Burlington Legal</div>
  <a class="nav-ac" onclick="goTo('feedPanel')">Acoes</a>
  <a onclick="goTo('sec-prazos')">Prazos</a>
  <a onclick="goTo('sec-update')">DataJud</a>
  <a onclick="goTo('sec-procs')">Tabela</a>
  <a onclick="window.open('/astrea','_blank')" style="color:#58a6ff;font-weight:600">&#9733; Astrea</a>
  <a onclick="window.open('/api/processos','_blank')">API</a>
</nav>

<div class="ctn">

<!-- HEADER -->
<div class="hdr">
  <div>
    <h1>Burlington English Latam LTDA</h1>
    <div class="sub">CNPJ: <b>08.049.394/0001-84</b> | Anteriormente: Mindset Institute</div>
    <div class="sub">Advogado de Defesa: <b>Victor Augusto Peres de Moura</b></div>
  </div>
  <div style="text-align:right">
    <div style="font-size:.8rem;color:#8b949e">Ultima consulta DataJud:</div>
    <div class="dbg dbg-g" id="lastUpdateBadge">Carregando...</div>
    <div style="margin-top:6px;font-size:.75rem;color:#484f58" id="cronStatus"></div>
  </div>
</div>

<!-- ACTION FEED PANEL -->
<div class="feed-panel" id="feedPanel">
  <div class="feed-hdr" onclick="toggleFeed()">
    <h2>&#9889; Ultimas Movimentacoes e Acoes Necessarias <span class="feed-count" id="feedCount">0</span></h2>
    <span class="feed-toggle open" id="feedToggle">&#9660;</span>
  </div>
  <div class="feed-body" id="feedBody">
    <div class="feed-tabs" id="feedTabs"></div>
    <div id="feedContent">
      <div class="feed-empty">Carregando...</div>
    </div>
  </div>
</div>

<!-- PRAZOS TABLE -->
<div class="prazos-panel" id="sec-prazos">
  <div class="prazos-hdr">
    <h2>&#9200; Prazos e Respostas Pendentes <span class="feed-count" id="prazosCount">0</span></h2>
    <div style="font-size:.78rem;color:#8b949e">Atualizado via Comunica PJe (tempo real)</div>
  </div>
  <div class="prazos-body">
    <table class="prazos-table">
      <thead>
        <tr>
          <th style="width:50px">ID</th>
          <th>Reclamante</th>
          <th>Tipo Decisao</th>
          <th style="width:130px">Publicacao</th>
          <th style="width:150px">Prazo Final</th>
          <th style="width:130px">Countdown</th>
          <th style="min-width:280px">O que Peticionar</th>
        </tr>
      </thead>
      <tbody id="prazosBody"></tbody>
    </table>
    <div id="prazosEmpty" style="display:none;text-align:center;padding:30px;color:#484f58">Nenhum prazo pendente identificado.</div>
  </div>
</div>

<!-- UPDATE PANEL -->
<div class="upd-panel" id="sec-update">
  <h2>&#128752; Central de Atualizacao DataJud (CNJ)</h2>

  <div class="upd-top">
    <div class="upd-info" id="statsCards"></div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn-update" id="btnUpdate" onclick="startUpdate()">
        &#128259; DataJud
      </button>
      <button class="btn-update" id="btnComunica" onclick="startComunicaUpdate()" style="background:linear-gradient(135deg,#1a6dd1,#58a6ff)">
        &#9889; Comunica PJe (Tempo Real)
      </button>
      <button style="background:#1c2333;color:#8b949e;border:1px solid #30363d;padding:10px 18px;border-radius:10px;cursor:pointer;font-size:.82rem" onclick="toggleLog()">
        Ver Log
      </button>
    </div>
  </div>

  <!-- PROGRESS -->
  <div class="prog-wrap" id="progWrap">
    <div class="prog-bar"><div class="prog-fill" id="progFill"></div></div>
    <div class="prog-text">
      <span id="progText">Aguardando...</span>
      <span id="progPct">0%</span>
    </div>
  </div>

  <!-- LOG -->
  <div class="log-panel" id="logPanel"></div>

  <!-- SEARCH -->
  <input type="text" class="upd-search" id="searchInput" placeholder="&#128269; Buscar processo por reclamante, numero ou acao...">

  <!-- TABLE -->
  <div class="upd-table-wrap" id="sec-procs">
    <table class="upd-table">
      <thead>
        <tr>
          <th data-sort="id" style="width:40px">ID</th>
          <th data-sort="reclamante">Reclamante</th>
          <th data-sort="numero" style="font-size:.68rem">Processo</th>
          <th data-sort="cidade">Cidade</th>
          <th data-sort="risco">Risco</th>
          <th data-sort="prioridade">Prior.</th>
          <th data-sort="ultima_mov_datajud">Ultima Mov. DataJud</th>
          <th data-sort="datajud_total_movimentos">Movs</th>
          <th data-sort="datajud_ultima_verificacao">Verificado</th>
          <th data-sort="comunica_ultima" style="color:#58a6ff">Intim. PJe</th>
          <th data-sort="acao" style="min-width:200px">Acao a Tomar</th>
        </tr>
      </thead>
      <tbody id="tableBody"></tbody>
    </table>
  </div>

  <!-- CRON INFO -->
  <div class="cron-info">
    <span class="cron-dot on"></span>
    <b>Atualizacao Automatica ATIVA</b><br>
    <b>DataJud (CNJ):</b> 07h e 19h (delay 30-60 dias) |
    <b style="color:#3fb950">Comunica PJe (TEMPO REAL):</b> 06h, 10h, 14h, 18h (intimacoes e publicacoes em tempo real).<br>
    Clique "Atualizar Agora" para DataJud, ou "Comunica PJe" para buscar intimacoes recentes.
  </div>
</div>

<!-- FOOTER -->
<div class="footer">
  Burlington Legal Dashboard v2.0 | API DataJud (CNJ) | Servidor: localhost:${PORT}<br>
  <a href="/api/status" target="_blank">/api/status</a> |
  <a href="/api/processos" target="_blank">/api/processos</a>
</div>

</div>

<button class="btt" id="btt" onclick="window.scrollTo({top:0,behavior:'smooth'})">&#8593;</button>

<script>
// === STATE ===
let processos = [];
let sortCol = 'id';
let sortDir = 1;
let pollInterval = null;

// === INIT ===
loadData();

// === LOAD DATA ===
async function loadData() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    processos = data.processos;

    // Update header
    const lastUp = data.updateState.lastUpdate || data.metadata.ultima_atualizacao_datajud;
    document.getElementById('lastUpdateBadge').textContent = lastUp ? formatDateTime(lastUp) : 'Nunca';
    document.getElementById('cronStatus').textContent = 'Cron: diario 07h e 19h | Processos: ' + processos.length;

    // Action feed + Prazos
    renderFeed();
    renderPrazos();

    // Stats cards
    renderStats(data);

    // Table
    renderTable();

    // Check if update is running
    if (data.updateState.running) {
      startPolling();
    }
  } catch (e) {
    console.error('Erro ao carregar dados:', e);
  }
}

// === ACTION FEED ===
let feedTab = 'urgentes';

function renderFeed() {
  // Build all feed items from processos
  const allItems = [];

  processos.forEach(p => {
    // Comunica PJe (lightweight - 1 item per process)
    if (p.comunica_ultima) {
      allItems.push({
        id: p.id,
        nome: p.reclamante,
        numero: p.numero,
        data: p.comunica_ultima.data,
        source: 'PJe',
        tipo: p.comunica_ultima.tipo,
        orgao: p.comunica_ultima.orgao || '',
        link: null,
        decisao: p.comunica_ultima.decisao || '',
        urgente: p.comunica_ultima.urgente || false,
        prazo_dias: p.comunica_ultima.prazo_dias,
        prazo_desc: '',
        resumo: p.acao || '',
        destinatarios: [],
        acaoCor: p.acaoCor,
        risco: p.risco,
        prioridade: p.prioridade,
        estrategia: p.estrategia || []
      });
    }
    // DataJud fallback
    else if (p.ultima_mov_datajud?.data) {
      allItems.push({
        id: p.id,
        nome: p.reclamante,
        numero: p.numero,
        data: p.ultima_mov_datajud.data,
        source: 'DataJud',
        tipo: 'Movimentacao',
        orgao: '',
        link: null,
        decisao: '',
        urgente: false,
        prazo_dias: null,
        prazo_desc: '',
        resumo: p.ultima_mov_datajud.descricao || '',
        destinatarios: [],
        acaoCor: p.acaoCor,
        risco: p.risco,
        prioridade: p.prioridade,
        estrategia: p.estrategia || []
      });
    }
  });

  // Sort by date descending
  allItems.sort((a, b) => (b.data || '').localeCompare(a.data || ''));

  // Categorize
  const urgentes = allItems.filter(i => i.urgente);
  const recentes7d = allItems.filter(i => {
    if (!i.data) return false;
    const diff = (new Date() - new Date(i.data)) / (1000*60*60*24);
    return diff <= 7;
  });
  const recentes30d = allItems.filter(i => {
    if (!i.data) return false;
    const diff = (new Date() - new Date(i.data)) / (1000*60*60*24);
    return diff <= 30;
  });
  // Unique process actions (one per process, most recent)
  const seen = new Set();
  const porProcesso = [];
  allItems.forEach(i => {
    if (!seen.has(i.id)) {
      seen.add(i.id);
      porProcesso.push(i);
    }
  });

  // Prazos - items with deadlines
  const comPrazo = [];
  processos.forEach(p => {
    if (p.prazo) {
      comPrazo.push({
        id: p.id, nome: p.reclamante, numero: p.numero,
        prazo: p.prazo, prazoAlerta: p.prazoAlerta,
        acao: p.acao, acaoCor: p.acaoCor, risco: p.risco,
        prioridade: p.prioridade, estrategia: p.estrategia || []
      });
    }
  });
  comPrazo.sort((a, b) => (a.prazo || '').localeCompare(b.prazo || ''));

  // Update feed count
  const urgCount = urgentes.length;
  const countEl = document.getElementById('feedCount');
  countEl.textContent = urgCount > 0 ? urgCount + ' urgentes' : 'OK';
  countEl.className = 'feed-count' + (urgCount > 0 ? '' : ' ok');

  // Tabs
  const tabs = [
    { id: 'urgentes', label: 'Urgentes', badge: urgentes.length, items: urgentes },
    { id: 'prazos', label: 'Prazos', badge: comPrazo.length, items: comPrazo },
    { id: '7dias', label: 'Ultimos 7 dias', badge: recentes7d.length, items: recentes7d },
    { id: '30dias', label: 'Ultimos 30 dias', badge: recentes30d.length, items: recentes30d },
    { id: 'todos', label: 'Todas (' + porProcesso.length + ')', badge: 0, items: porProcesso }
  ];

  // Store for tab switching
  window._feedTabs = tabs;

  let tabHtml = '';
  tabs.forEach(t => {
    const active = t.id === feedTab ? ' active' : '';
    const badge = t.badge > 0 ? '<span class="tab-badge">' + t.badge + '</span>' : '';
    tabHtml += '<button class="feed-tab' + active + '" data-ftab="' + t.id + '">' + t.label + badge + '</button>';
  });
  document.getElementById('feedTabs').innerHTML = tabHtml;

  // Bind tab clicks
  document.querySelectorAll('.feed-tab').forEach(btn => {
    btn.addEventListener('click', function() {
      feedTab = this.getAttribute('data-ftab');
      renderFeed();
    });
  });

  // Render active tab content
  const activeTab = tabs.find(t => t.id === feedTab) || tabs[0];
  renderFeedItems(activeTab);
}

function renderFeedItems(tab) {
  const items = tab.items;
  if (!items || items.length === 0) {
    document.getElementById('feedContent').innerHTML = '<div class="feed-empty">Nenhum item nesta categoria.</div>';
    return;
  }

  const isPrazos = tab.id === 'prazos';
  let html = '';

  items.forEach(item => {
    // Determine icon
    let icon = '&#128196;', iconClass = 'blue';
    if (isPrazos) {
      icon = '&#9200;';
      const hoje = new Date().toISOString().substring(0,10);
      if (item.prazo && item.prazo <= hoje) { iconClass = 'red'; }
      else if (item.prazo) {
        const diff = (new Date(item.prazo) - new Date()) / (1000*60*60*24);
        iconClass = diff <= 7 ? 'red' : diff <= 15 ? 'orange' : 'blue';
      }
    } else if (item.urgente) {
      icon = '&#9888;'; iconClass = 'red';
    } else if (item.decisao && item.decisao.includes('PENHORA')) {
      icon = '&#128274;'; iconClass = 'red';
    } else if (item.decisao && item.decisao.includes('BLOQUEIO')) {
      icon = '&#128374;'; iconClass = 'red';
    } else if (item.decisao && item.decisao.includes('DESCONSIDERACAO')) {
      icon = '&#9763;'; iconClass = 'red';
    } else if (item.decisao && item.decisao.includes('AUDIENCIA')) {
      icon = '&#128197;'; iconClass = 'orange';
    } else if (item.decisao && item.decisao.includes('SENTENCA')) {
      icon = '&#9878;'; iconClass = 'purple';
    } else if (item.source === 'DataJud') {
      icon = '&#128752;'; iconClass = 'blue';
    }

    // Date class
    let dateClass = 'feed-date';
    if (item.data) {
      const diff = (new Date() - new Date(item.data)) / (1000*60*60*24);
      dateClass += diff <= 7 ? ' recent' : diff <= 30 ? ' warning' : ' danger';
    }

    html += '<div class="feed-item" onclick="openModal(' + item.id + ')">';
    html += '<div class="feed-icon ' + iconClass + '">' + icon + '</div>';
    html += '<div class="feed-content">';

    // Title
    html += '<div class="feed-title">';
    html += esc(item.nome);
    html += ' <span class="feed-id">#' + item.id + '</span>';
    if (item.decisao) html += ' <span class="acao-badge acao-' + (item.urgente ? 'vermelho' : 'azul') + '" style="font-size:.7rem">' + esc(item.decisao) + '</span>';
    html += '</div>';

    // Description
    if (isPrazos) {
      html += '<div class="feed-desc"><b>Prazo:</b> ' + esc(String(item.prazo)) + (item.prazoAlerta ? ' - ' + esc(item.prazoAlerta) : '') + '</div>';
      html += '<div class="feed-desc" style="margin-top:4px"><b>Acao:</b> ' + esc(item.acao || '') + '</div>';
    } else {
      const desc = item.resumo || item.tipo || '';
      html += '<div class="feed-desc">' + esc(truncate(desc, 180)) + '</div>';
    }

    // Meta
    html += '<div class="feed-meta">';
    if (item.data) html += '<span class="' + dateClass + '">' + item.data + '</span>';
    if (item.source) html += '<span class="feed-tag">' + item.source + '</span>';
    if (item.tipo && !isPrazos) html += '<span class="feed-tag">' + esc(item.tipo) + '</span>';
    if (item.orgao) html += '<span class="feed-tag">' + esc(item.orgao) + '</span>';
    if (item.prazo_dias && !isPrazos) html += '<span class="feed-prazo">Prazo: ' + item.prazo_dias + ' dias</span>';
    if (item.link) html += '<a href="' + esc(item.link) + '" target="_blank" onclick="event.stopPropagation()" style="font-size:.72rem;color:#58a6ff;text-decoration:none;padding:2px 8px;background:rgba(88,166,255,.1);border-radius:4px">Ver PJe</a>';
    html += '</div>';

    // Estrategia preview (first item only for urgentes)
    if (item.urgente && item.estrategia && item.estrategia.length > 0) {
      const firstStrat = item.estrategia[0];
      html += '<div style="margin-top:8px;font-size:.78rem;color:#d29922;background:rgba(210,153,34,.06);border-left:3px solid #d29922;padding:6px 10px;border-radius:0 6px 6px 0">' + esc(truncate(firstStrat, 200)) + '</div>';
    }

    html += '</div></div>';
  });

  document.getElementById('feedContent').innerHTML = html;
}

function toggleFeed() {
  const body = document.getElementById('feedBody');
  const tgl = document.getElementById('feedToggle');
  body.style.display = body.style.display === 'none' ? '' : 'none';
  tgl.classList.toggle('open');
}

// === PRAZOS TABLE ===
function renderPrazos() {
  const hoje = new Date();
  hoje.setHours(0,0,0,0);

  // Build prazos list
  const prazos = [];
  processos.forEach(p => {
    // Determine prazo data and type
    let prazoData = null;
    let tipoDecisao = '';
    let publicacao = '';
    let prazoDias = null;

    // From Comunica PJe (priority)
    if (p.comunica_ultima) {
      publicacao = p.comunica_ultima.data || '';
      tipoDecisao = p.comunica_ultima.decisao || p.comunica_ultima.tipo || '';
      prazoDias = p.comunica_ultima.prazo_dias;
    }

    // Use calculated prazo
    if (p.prazo && p.prazo.match(/^\\d{4}-/)) {
      prazoData = p.prazo;
    }

    // If proxima audiencia
    if (p.proxima_audiencia) {
      const ad = typeof p.proxima_audiencia === 'object' ? p.proxima_audiencia.data : String(p.proxima_audiencia);
      if (ad && ad.match(/^\\d{4}-/)) {
        prazoData = ad;
        if (!tipoDecisao) tipoDecisao = 'AUDIENCIA';
      }
    }

    if (!prazoData) return;

    // Calculate sugestao de peticao
    let peticao = '';
    const fase = (p.fase || '').toLowerCase();
    const td = tipoDecisao.toUpperCase();

    if (td.includes('DESCONSIDERACAO')) {
      peticao = 'Peticionar: DEFESA NO INCIDENTE DE DESCONSIDERACAO - Arguir ausencia de abuso da personalidade juridica, que nao houve confusao patrimonial (art. 50 CC). Requerer producao de provas. Arguir que imovel residencial e bem de familia (Lei 8.009/90).';
    } else if (td.includes('PENHORA')) {
      peticao = 'Peticionar: IMPUGNACAO A PENHORA - Arguir impenhorabilidade do bem (art. 833 CPC). Se imovel, arguir bem de familia (Lei 8.009/90). Se veiculo, arguir ferramenta de trabalho. Requerer substituicao da penhora.';
    } else if (td.includes('BLOQUEIO')) {
      peticao = 'Peticionar: DESBLOQUEIO DE VALORES - Arguir impenhorabilidade de salarios (art. 833, IV CPC). Comprovar natureza alimentar dos valores bloqueados. Requerer liberacao imediata e substituicao da constricao.';
    } else if (td.includes('AUDIENCIA')) {
      peticao = 'Preparar: CARTA DE PREPOSICAO atualizada, documentos comprobatorios, rol de testemunhas. Avaliar proposta de acordo parcelado. Comparecer pontualmente (revelia se ausente).';
    } else if (td.includes('SENTENCA')) {
      peticao = 'Peticionar: RECURSO ORDINARIO (8 dias uteis) - Impugnar pontos desfavoraveis. Prequestionar materia constitucional. Requerer efeito suspensivo se possivel. Deposito recursal obrigatorio.';
    } else if (td.includes('ACORDAO')) {
      peticao = 'Peticionar: RECURSO DE REVISTA (8 dias uteis) - Demonstrar violacao legal ou divergencia jurisprudencial. Prequestionamento obrigatorio. Deposito recursal complementar.';
    } else if (fase.includes('execu')) {
      peticao = 'Peticionar: EMBARGOS A EXECUCAO ou EXCEPCAO DE PRE-EXECUTIVIDADE - Impugnar calculos excessivos. Alternativamente, requerer PARCELAMENTO (art. 916 CPC - 30% entrada + 6x). Arguir impenhorabilidade dos bens.';
    } else if (td.includes('DESPACHO')) {
      peticao = 'Verificar teor do despacho para identificar determinacao especifica. Cumprir no prazo para evitar preclusao. Se desfavoravel, avaliar agravo de peticao.';
    } else {
      peticao = 'Verificar intimacao e cumprir determinacao judicial no prazo. Peticionar manifestacao demonstrando ciencia. Monitorar proximas movimentacoes.';
    }

    const prazoDate = new Date(prazoData + 'T00:00:00');
    const diffMs = prazoDate - hoje;
    const diffDias = Math.ceil(diffMs / (1000*60*60*24));

    prazos.push({
      id: p.id,
      reclamante: p.reclamante,
      tipoDecisao,
      publicacao,
      prazoData,
      diffDias,
      peticao,
      risco: p.risco,
      prioridade: p.prioridade,
      acaoCor: p.acaoCor
    });
  });

  // Sort: most urgent first (vencidos, then closest deadline)
  prazos.sort((a, b) => a.diffDias - b.diffDias);

  // Update count
  const vencidos = prazos.filter(p => p.diffDias <= 0).length;
  const proximos = prazos.filter(p => p.diffDias > 0 && p.diffDias <= 7).length;
  const countEl = document.getElementById('prazosCount');
  if (vencidos > 0) {
    countEl.textContent = vencidos + ' VENCIDOS';
    countEl.className = 'feed-count';
  } else if (proximos > 0) {
    countEl.textContent = proximos + ' esta semana';
    countEl.className = 'feed-count';
  } else {
    countEl.textContent = prazos.length + ' prazos';
    countEl.className = 'feed-count ok';
  }

  if (prazos.length === 0) {
    document.getElementById('prazosBody').innerHTML = '';
    document.getElementById('prazosEmpty').style.display = '';
    return;
  }
  document.getElementById('prazosEmpty').style.display = 'none';

  let html = '';
  prazos.forEach(p => {
    // Countdown display
    let cdClass, cdText;
    if (p.diffDias < 0) {
      cdClass = 'vencido';
      cdText = Math.abs(p.diffDias) + 'd VENCIDO';
    } else if (p.diffDias === 0) {
      cdClass = 'vencido';
      cdText = 'HOJE';
    } else if (p.diffDias <= 3) {
      cdClass = 'critico';
      cdText = p.diffDias + ' dia' + (p.diffDias > 1 ? 's' : '');
    } else if (p.diffDias <= 10) {
      cdClass = 'alerta';
      cdText = p.diffDias + ' dias';
    } else {
      cdClass = 'ok';
      cdText = p.diffDias + ' dias';
    }

    // Tipo decisao badge
    const isUrgent = p.tipoDecisao.includes('DESCONSIDERACAO') || p.tipoDecisao.includes('PENHORA') || p.tipoDecisao.includes('BLOQUEIO');
    const tdBadge = isUrgent ? 'vermelho' : (p.tipoDecisao.includes('AUDIENCIA') ? 'laranja' : 'azul');

    html += '<tr onclick="openModal(' + p.id + ')">';
    html += '<td><b>' + p.id + '</b></td>';
    html += '<td><b style="color:#58a6ff">' + esc(p.reclamante) + '</b></td>';
    html += '<td><span class="acao-badge acao-' + tdBadge + '">' + esc(p.tipoDecisao || 'N/A') + '</span></td>';
    html += '<td style="font-size:.8rem">' + esc(p.publicacao) + '</td>';
    html += '<td style="font-size:.85rem;font-weight:600">' + esc(p.prazoData) + '</td>';
    html += '<td><span class="countdown ' + cdClass + '">' + cdText + '</span></td>';
    html += '<td><div class="peticao-box">' + esc(p.peticao) + '</div></td>';
    html += '</tr>';
  });

  document.getElementById('prazosBody').innerHTML = html;
}

// Update countdowns every minute
setInterval(() => { if (processos.length > 0) renderPrazos(); }, 60000);

// === STATS ===
function renderStats(data) {
  const total = processos.length;
  const encontrados = data.metadata.processos_encontrados_datajud || 0;
  const naoEncontrados = data.metadata.processos_nao_encontrados_datajud || 0;

  // Count by priority
  let criticos = 0, altos = 0, vermelhos = 0;
  processos.forEach(p => {
    const pr = (p.prioridade || '').toLowerCase();
    if (pr.includes('crit') || pr.includes('maxim') || pr.includes('urgent')) criticos++;
    else if (pr.includes('alta')) altos++;
    if (p.acaoCor === 'vermelho') vermelhos++;
  });

  document.getElementById('statsCards').innerHTML =
    '<div class="upd-stat"><div class="n">' + total + '</div><div class="l">Total Processos</div></div>' +
    '<div class="upd-stat st-g"><div class="n">' + encontrados + '</div><div class="l">Encontrados DataJud</div></div>' +
    '<div class="upd-stat st-o"><div class="n">' + naoEncontrados + '</div><div class="l">Nao Encontrados</div></div>' +
    '<div class="upd-stat st-r"><div class="n">' + vermelhos + '</div><div class="l">Acoes Urgentes</div></div>' +
    '<div class="upd-stat"><div class="n">' + criticos + '</div><div class="l">Prioridade Critica</div></div>' +
    '<div class="upd-stat"><div class="n">' + altos + '</div><div class="l">Prioridade Alta</div></div>';
}

// === TABLE ===
function renderTable() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  let filtered = processos;
  if (search) {
    filtered = processos.filter(p =>
      p.reclamante.toLowerCase().includes(search) ||
      p.numero.includes(search) ||
      (p.acao || '').toLowerCase().includes(search) ||
      (p.cidade || '').toLowerCase().includes(search)
    );
  }

  filtered.sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (sortCol === 'ultima_mov_datajud') {
      va = a.ultima_mov_datajud?.data || '';
      vb = b.ultima_mov_datajud?.data || '';
    }
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va == null) va = '';
    if (vb == null) vb = '';
    if (va < vb) return -sortDir;
    if (va > vb) return sortDir;
    return 0;
  });

  let html = '';
  filtered.forEach(p => {
    const movDate = p.ultima_mov_datajud?.data || '--';
    const movDesc = p.ultima_mov_datajud?.descricao || p.datajud_movimentos_recentes?.[0]?.descricao || '';
    const verif = p.datajud_ultima_verificacao ? formatDateTime(p.datajud_ultima_verificacao) : '--';
    const totalMovs = p.datajud_total_movimentos || 0;
    const dateClass = getDateClass(movDate);

    html += '<tr onclick="openModal('+p.id+')" style="cursor:pointer">';
    html += '<td><b>' + p.id + '</b></td>';
    html += '<td><b style="color:#58a6ff;text-decoration:underline;cursor:pointer">' + esc(p.reclamante) + '</b></td>';
    html += '<td style="font-size:.72rem;color:#8b949e;font-family:monospace">' + esc(p.numero) + '</td>';
    html += '<td style="font-size:.76rem">' + esc(p.cidade || '') + '</td>';
    html += '<td>' + riskBg(p.risco) + '</td>';
    html += '<td>' + priorBg(p.prioridade) + '</td>';
    html += '<td><span class="' + dateClass + '">' + movDate + '</span>';
    if (movDesc) html += '<br><span style="font-size:.7rem;color:#8b949e" title="' + esc(movDesc) + '">' + esc(movDesc.substring(0, 50)) + '</span>';
    html += '</td>';
    html += '<td style="text-align:center;font-family:monospace">' + totalMovs + '</td>';
    html += '<td style="font-size:.72rem;color:#8b949e">' + verif + '</td>';
    // Comunica PJe column
    const comData = p.comunica_ultima?.data || '--';
    const comTipo = p.comunica_ultima?.tipo || '';
    const comClass = getDateClass(comData);
    const comBadge = p.comunica_mais_recente ? ' style="font-weight:700"' : '';
    html += '<td><span class="' + comClass + '"' + comBadge + '>' + comData + '</span>';
    if (comTipo) html += '<br><span style="font-size:.68rem;color:#8b949e">' + esc(comTipo) + '</span>';
    html += '</td>';
    html += '<td><span class="acao-badge acao-' + p.acaoCor + '" title="' + esc(p.acao) + '">' + esc(truncate(p.acao, 50)) + '</span></td>';
    html += '</tr>';
  });

  document.getElementById('tableBody').innerHTML = html;
}

// === MODAL POPUP ===
async function openModal(id) {
  // Show loading state immediately
  document.getElementById('modalContent').innerHTML = '<div style="padding:60px;text-align:center;color:#8b949e"><div style="font-size:2rem;margin-bottom:12px">&#9203;</div>Carregando processo #' + id + '...</div>';
  document.getElementById('modalOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';

  // Fetch full data on demand
  let p;
  try {
    const res = await fetch('/api/processo/' + id);
    p = await res.json();
    if (p.error) { closeModal(); return; }
  } catch(e) { closeModal(); return; }

  const fmt = v => v ? 'R$ ' + Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2}) : 'N/A';
  const yn = v => v ? '<span style="color:#f85149;font-weight:700">SIM</span>' : '<span style="color:#3fb950">Nao</span>';
  const movDate = p.ultima_mov_datajud?.data || '--';
  const movDesc = p.ultima_mov_datajud?.descricao || '';

  let h = '';

  // HEADER
  h += '<div class="modal-hdr">';
  h += '<div><h2>#' + p.id + ' - ' + esc(p.reclamante) + '</h2>';
  h += '<div style="font-size:.8rem;color:#8b949e;margin-top:4px">' + esc(p.numero) + ' | ' + esc(p.vara) + '</div></div>';
  h += '<div class="badges">' + riskBg(p.risco) + ' ' + priorBg(p.prioridade);
  h += ' <button class="btn-full" onclick="openFullProcess(' + p.id + ')" id="btnFull' + p.id + '">&#128269; Processo Full</button>';
  h += ' <button class="modal-close" onclick="closeModal()">&#10005; Fechar</button></div>';
  h += '</div>';

  h += '<div class="modal-body">';

  // PRAZO / DEADLINE
  const isSafe = !p.prazo || p.prazo === 'Verificar intimacao' ? false : new Date(p.prazo) > new Date();
  h += '<div class="prazo-box' + (p.causa_ganha_burlington || p.extinto_inercia_reclamante ? ' safe' : '') + '">';
  h += '<h3>' + (p.prazo ? '&#9200; PRAZO / DEADLINE' : '&#9200; SITUACAO DE PRAZO') + '</h3>';
  if (p.prazo) {
    h += '<div class="prazo-date">' + esc(String(p.prazo)) + '</div>';
  } else {
    h += '<div class="prazo-date">Sem prazo imediato identificado</div>';
  }
  if (p.prazoAlerta) h += '<div class="prazo-desc">' + esc(p.prazoAlerta) + '</div>';
  if (p.proxima_audiencia) {
    const au = typeof p.proxima_audiencia === 'object' ? p.proxima_audiencia : {data: String(p.proxima_audiencia)};
    h += '<div style="margin-top:8px;padding:10px;background:rgba(248,81,73,.1);border-radius:8px">';
    h += '<b style="color:#f85149">AUDIENCIA:</b> ' + esc(au.data || '') + ' ' + esc(au.hora || '');
    if (au.tipo) h += ' | Tipo: ' + esc(au.tipo);
    if (au.local) h += ' | Local: ' + esc(au.local);
    if (au.link) h += ' | <a href="' + esc(au.link) + '" target="_blank" style="color:#58a6ff">Link</a>';
    h += '</div>';
  }
  h += '</div>';

  // ESTRATEGIA DE DEFESA / PROTECAO PATRIMONIAL
  h += '<div class="strat-box">';
  h += '<h3>&#128737; ESTRATEGIA DE DEFESA - PROTECAO PATRIMONIAL</h3>';
  (p.estrategia || []).forEach(s => {
    const isUrgent = s.startsWith('URGENTE') || s.startsWith('BLOQUEIO') || s.startsWith('PENHORA') || s.startsWith('REVELIA');
    const isPositive = s.startsWith('POSITIVO') || s.startsWith('FAVORAVEL');
    h += '<div class="strat-item' + (isUrgent ? ' urgent' : '') + (isPositive ? ' positive' : '') + '">' + esc(s) + '</div>';
  });
  h += '</div>';

  // ACAO SUGERIDA
  if (p.acao_sugerida) {
    h += '<div class="m-section"><h3>&#127919; Acao Sugerida</h3>';
    h += '<div style="background:rgba(88,166,255,.08);border:1px solid rgba(88,166,255,.2);border-radius:10px;padding:14px 18px;font-size:.88rem">' + esc(p.acao_sugerida) + '</div>';
    h += '</div>';
  }

  // ALERTAS
  const alertas = [];
  if (p.desconsideracao_pj_burlington) alertas.push('DESCONSIDERACAO PJ BURLINGTON - Socios Raphael e Brassplate em risco');
  if (p.desconsideracao_pj_frramos) alertas.push('DESCONSIDERACAO PJ FRRAMOS - Fernanda em risco');
  if (p.pedido_bloqueio_conta_pj) alertas.push('Pedido BLOQUEIO conta PJ via SISBAJUD');
  if (p.pedido_bloqueio_conta_socios) alertas.push('Pedido BLOQUEIO conta dos SOCIOS');
  if (p.pedido_automovel) alertas.push('Pedido PENHORA de VEICULO');
  if (p.pedido_imovel_burlington) alertas.push('Pedido penhora IMOVEL Burlington');
  if (p.pedido_imovel_frramos) alertas.push('Pedido penhora IMOVEL FRRamos');
  if (p.burlington_revel) alertas.push('BURLINGTON REVEL - Confissao ficta');
  if (p.grupo_economico_reconhecido) alertas.push('GRUPO ECONOMICO RECONHECIDO');
  if (alertas.length) {
    h += '<div class="alert-box"><div class="alert-title">&#9888; ALERTAS DE RISCO (' + alertas.length + ')</div><ul>';
    alertas.forEach(a => { h += '<li>&#9679; ' + esc(a) + '</li>'; });
    h += '</ul></div>';
  }

  // DADOS GERAIS
  h += '<div class="m-section"><h3>&#128196; Dados do Processo</h3>';
  h += '<div class="m-grid">';
  h += '<div class="m-field"><div class="lbl">Tipo</div><div class="val">' + esc(p.tipo || '') + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Grau</div><div class="val">' + esc(p.grau || '') + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Tribunal</div><div class="val">' + esc(p.tribunal || '') + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Vara</div><div class="val">' + esc(p.vara || '') + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Cidade</div><div class="val">' + esc(p.cidade || '') + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Autuacao</div><div class="val">' + esc(p.data_autuacao || '') + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Status</div><div class="val">' + esc(p.status || '') + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Fase</div><div class="val">' + esc(p.fase || '') + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Adv. Reclamante</div><div class="val">' + esc(p.advogado_reclamante || '') + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Defesa Aceita</div><div class="val">' + yn(p.defesa_aceita) + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Resultado Burlington</div><div class="val">' + esc(p.resultado_burlington || 'Pendente') + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Resultado FRRamos</div><div class="val">' + esc(p.resultado_frramos || 'N/A') + '</div></div>';
  h += '</div></div>';

  // VALORES
  h += '<div class="m-section"><h3>&#128176; Valores</h3>';
  h += '<div class="m-grid">';
  h += '<div class="m-field"><div class="lbl">Valor da Causa</div><div class="val val-big val-orange">' + fmt(p.valor_causa) + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Valor Condenacao</div><div class="val val-big val-red">' + fmt(p.valor_condenacao) + '</div></div>';
  if (p.valor_acordo) h += '<div class="m-field"><div class="lbl">Valor Acordo</div><div class="val val-big val-green">' + fmt(p.valor_acordo) + '</div></div>';
  if (p.valor_bloqueado) h += '<div class="m-field"><div class="lbl">Valor Bloqueado</div><div class="val val-big val-red">' + fmt(p.valor_bloqueado) + '</div></div>';
  if (p.valor_liquido_execucao) h += '<div class="m-field"><div class="lbl">Valor Liq. Execucao</div><div class="val val-big val-red">' + fmt(p.valor_liquido_execucao) + '</div></div>';
  h += '</div></div>';

  // FLAGS PATRIMONIAIS
  h += '<div class="m-section"><h3>&#128274; Riscos Patrimoniais</h3>';
  h += '<div class="m-grid">';
  h += '<div class="m-field"><div class="lbl">Desc. PJ Burlington</div><div class="val">' + yn(p.desconsideracao_pj_burlington) + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Desc. PJ FRRamos</div><div class="val">' + yn(p.desconsideracao_pj_frramos) + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Grupo Economico</div><div class="val">' + yn(p.grupo_economico_reconhecido) + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Bloqueio Conta PJ</div><div class="val">' + yn(p.pedido_bloqueio_conta_pj) + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Bloqueio Socios</div><div class="val">' + yn(p.pedido_bloqueio_conta_socios) + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Burlington Revel</div><div class="val">' + yn(p.burlington_revel) + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Penhora Veiculo</div><div class="val">' + yn(p.pedido_automovel) + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Penhora Imovel Burlington</div><div class="val">' + yn(p.pedido_imovel_burlington) + '</div></div>';
  h += '<div class="m-field"><div class="lbl">Penhora Imovel FRRamos</div><div class="val">' + yn(p.pedido_imovel_frramos) + '</div></div>';
  h += '</div></div>';

  // COMUNICACOES PJe (TEMPO REAL)
  const comms = p.comunicacoes || p.comunicacoes_recentes || [];
  if (comms.length > 0) {
    h += '<div class="m-section" style="border:2px solid rgba(88,166,255,.3);border-radius:12px;padding:16px;background:rgba(88,166,255,.04)">';
    h += '<h3 style="color:#58a6ff">&#9889; INTIMACOES TEMPO REAL (Comunica PJe) - ' + (p.comunica_total||comms.length) + ' comunicacoes</h3>';
    h += '<div style="background:rgba(63,185,80,.1);border:1px solid rgba(63,185,80,.3);border-radius:8px;padding:8px 14px;margin-bottom:12px;font-size:.82rem;color:#3fb950"><b>DADOS EM TEMPO REAL</b> - Intimacoes do diario oficial eletronico</div>';
    comms.forEach((c, idx) => {
      const isUrgent = c.parsed?.urgente;
      const borderColor = isUrgent ? 'rgba(248,81,73,.4)' : 'rgba(88,166,255,.2)';
      const bgColor = isUrgent ? 'rgba(248,81,73,.06)' : 'rgba(0,0,0,.2)';
      h += '<div style="background:'+bgColor+';border:1px solid '+borderColor+';border-radius:10px;padding:14px 18px;margin-bottom:10px">';
      h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:6px">';
      h += '<div><span style="color:#58a6ff;font-weight:700;font-size:.9rem">' + esc(c.data) + '</span>';
      h += ' <span style="color:#8b949e;font-size:.78rem">' + esc(c.tipo) + '</span>';
      h += ' <span style="color:#bc8cff;font-size:.75rem">' + esc(c.orgao || '') + '</span></div>';
      if (c.link) h += '<a href="' + esc(c.link) + '" target="_blank" style="color:#58a6ff;font-size:.78rem;text-decoration:none;background:rgba(88,166,255,.1);padding:4px 10px;border-radius:6px">Ver no PJe</a>';
      h += '</div>';
      if (c.parsed?.tipo_decisao) {
        h += '<div style="margin-bottom:6px"><span class="acao-badge acao-' + (isUrgent ? 'vermelho' : 'azul') + '">' + esc(c.parsed.tipo_decisao) + '</span>';
        if (c.parsed.prazo_dias) h += ' <span class="acao-badge acao-laranja">Prazo: ' + c.parsed.prazo_dias + ' dias - ' + esc(c.parsed.prazo_descricao) + '</span>';
        h += '</div>';
      }
      if (c.parsed?.conteudo_resumido) {
        h += '<div style="font-size:.8rem;color:#8b949e;line-height:1.6;max-height:100px;overflow-y:auto">' + esc(c.parsed.conteudo_resumido) + '</div>';
      }
      if (c.destinatarios?.length) {
        h += '<div style="margin-top:6px;font-size:.72rem;color:#484f58">Destinatarios: ' + c.destinatarios.map(d => esc(d)).join(', ') + '</div>';
      }
      h += '</div>';
    });
    h += '</div></div>';
  } else {
    h += '<div class="m-section"><div style="background:rgba(210,153,34,.06);border:1px solid rgba(210,153,34,.2);border-radius:10px;padding:12px 18px;font-size:.82rem;color:#d29922">';
    h += '&#9889; <b>Comunica PJe:</b> ' + (p.comunica_total > 0 ? p.comunica_total + ' comunicacoes encontradas' : 'Sem comunicacoes. Clique "Comunica PJe" para buscar.');
    h += '</div></div>';
  }

  // ULTIMA MOVIMENTACAO DATAJUD
  h += '<div class="m-section"><h3>&#128752; Movimentacoes DataJud (CNJ) - delay 30-60 dias</h3>';
  h += '<div style="display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap">';
  h += '<div style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px 16px"><div style="font-size:.7rem;color:#8b949e">Ultima Mov.</div><div style="font-size:1rem;font-weight:700;color:#58a6ff">' + movDate + '</div></div>';
  h += '<div style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px 16px"><div style="font-size:.7rem;color:#8b949e">Total Movimentos</div><div style="font-size:1rem;font-weight:700;color:#bc8cff">' + (p.datajud_total_movimentos||0) + '</div></div>';
  h += '<div style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px 16px"><div style="font-size:.7rem;color:#8b949e">Verificado</div><div style="font-size:1rem;font-weight:700;color:#8b949e">' + (p.datajud_ultima_verificacao ? formatDateTime(p.datajud_ultima_verificacao) : '--') + '</div></div>';
  h += '</div>';

  if (p.datajud_movimentos_recentes && p.datajud_movimentos_recentes.length) {
    h += '<div class="tl">';
    p.datajud_movimentos_recentes.forEach((m,i) => {
      h += '<div class="tl-item"><div class="tl-date">' + esc(m.data || '') + (m.grau ? '<span class="tl-grau">[' + esc(m.grau) + ']</span>' : '') + '</div>';
      h += '<div class="tl-desc">' + esc(m.descricao || '') + '</div></div>';
    });
    h += '</div>';
  }
  h += '</div>';

  // HISTORICO LOCAL
  if (p.historico_movimentacoes && p.historico_movimentacoes.length) {
    h += '<div class="m-section"><h3>&#128197; Historico de Movimentacoes (Local)</h3>';
    h += '<div class="tl">';
    const sorted = [...p.historico_movimentacoes].sort((a,b) => (b.data||'').localeCompare(a.data||''));
    sorted.forEach(m => {
      h += '<div class="tl-item"><div class="tl-date">' + esc(m.data || '') + '</div>';
      h += '<div class="tl-desc">' + esc(m.descricao || '') + '</div></div>';
    });
    h += '</div></div>';
  }

  // VERBAS
  if ((p.verbas_deferidas && p.verbas_deferidas.length) || (p.pedidos_indeferidos && p.pedidos_indeferidos.length)) {
    h += '<div class="m-section"><h3>&#9878; Verbas e Pedidos</h3>';
    if (p.verbas_deferidas && p.verbas_deferidas.length) {
      h += '<div style="margin-bottom:8px;font-size:.82rem;color:#f85149;font-weight:600">Verbas Deferidas (contra nos):</div>';
      h += '<div class="tag-list">';
      p.verbas_deferidas.forEach(v => { h += '<span class="tag tag-r">' + esc(v) + '</span>'; });
      h += '</div>';
    }
    if (p.pedidos_indeferidos && p.pedidos_indeferidos.length) {
      h += '<div style="margin-top:12px;margin-bottom:8px;font-size:.82rem;color:#3fb950;font-weight:600">Pedidos Indeferidos (a nosso favor):</div>';
      h += '<div class="tag-list">';
      p.pedidos_indeferidos.forEach(v => { h += '<span class="tag tag-g">' + esc(v) + '</span>'; });
      h += '</div>';
    }
    h += '</div>';
  }

  // OBSERVACOES
  if (p.observacoes) {
    h += '<div class="m-section"><h3>&#128221; Observacoes</h3>';
    h += '<div style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:14px 18px;font-size:.84rem;color:#8b949e;line-height:1.7">' + esc(p.observacoes) + '</div>';
    h += '</div>';
  }

  h += '</div>'; // modal-body

  document.getElementById('modalContent').innerHTML = h;
}

// === PROCESSO FULL ===
async function openFullProcess(id) {
  const btn = document.getElementById('btnFull' + id);
  if (btn) { btn.classList.add('loading'); btn.innerHTML = '&#9203; Buscando DataJud + PJe...'; }

  try {
    const res = await fetch('/api/processo/' + id + '/full');
    const p = await res.json();
    if (p.error) { alert('Erro: ' + p.error); return; }

    const fmt = v => v ? 'R$ ' + Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2}) : 'N/A';
    const yn = v => v ? '<span style="color:#f85149;font-weight:700">SIM</span>' : '<span style="color:#3fb950">Nao</span>';
    let h = '';

    // HEADER
    h += '<div class="modal-hdr" style="background:linear-gradient(135deg,#1a3a1a,#0d1117);border-bottom:2px solid #3fb950">';
    h += '<div><h2 style="color:#3fb950">&#128269; #' + p.id + ' - ' + esc(p.reclamante) + ' (PROCESSO FULL)</h2>';
    h += '<div style="font-size:.8rem;color:#8b949e;margin-top:4px">' + esc(p.numero) + ' | ' + esc(p.vara) + '</div>';
    h += '<div style="font-size:.72rem;color:#3fb950;margin-top:4px">Dados em tempo real: DataJud + Comunica PJe | Buscado: ' + new Date(p.fetched_at).toLocaleString('pt-BR') + '</div></div>';
    h += '<div class="badges">' + riskBg(p.risco) + ' ' + priorBg(p.prioridade);
    h += ' <button class="btn-full" onclick="openModal(' + p.id + ')">&#8592; Voltar Resumo</button>';
    h += ' <button class="modal-close" onclick="closeModal()">&#10005; Fechar</button></div>';
    h += '</div>';

    h += '<div class="modal-body">';

    // PARTES DO PROCESSO
    if (p.datajud_partes && p.datajud_partes.length) {
      h += '<div class="full-section"><div class="full-section-hdr" onclick="toggleNext(this)">';
      h += '<span style="color:#bc8cff">&#128101; Partes do Processo (' + p.datajud_partes.length + ')</span><span style="color:#484f58">&#9660;</span></div>';
      h += '<div class="full-section-body">';
      p.datajud_partes.forEach(pt => {
        const isRecl = (pt.tipo||'').toUpperCase().includes('AUTOR') || (pt.tipo||'').toUpperCase().includes('RECLAMAN');
        const isReu = (pt.tipo||'').toUpperCase().includes('REU') || (pt.tipo||'').toUpperCase().includes('RECLAMA');
        const color = isRecl ? '#f85149' : (isReu ? '#d29922' : '#8b949e');
        h += '<div class="full-parte"><div><span style="color:'+color+';font-weight:600">' + esc(pt.nome) + '</span>';
        h += ' <span style="color:#484f58;font-size:.75rem">(' + esc(pt.tipo||'') + ')</span></div>';
        if (pt.advogados && pt.advogados.length) h += '<div style="font-size:.75rem;color:#8b949e">Adv: ' + pt.advogados.map(a => esc(a)).join(', ') + '</div>';
        h += '</div>';
      });
      h += '</div></div>';
    }

    // ASSUNTOS
    if (p.datajud_assuntos && p.datajud_assuntos.length) {
      h += '<div class="full-section"><div class="full-section-hdr">';
      h += '<span style="color:#d29922">&#128220; Assuntos</span></div>';
      h += '<div class="full-section-body" style="display:flex;flex-wrap:wrap;gap:8px">';
      p.datajud_assuntos.forEach(a => {
        h += '<span style="background:rgba(210,153,34,.1);color:#d29922;padding:6px 14px;border-radius:8px;font-size:.8rem;border:1px solid rgba(210,153,34,.2)">' + esc(a.nome) + ' <span style="color:#484f58">('+a.codigo+')</span></span>';
      });
      h += '</div></div>';
    }

    // VALORES
    h += '<div class="full-section"><div class="full-section-hdr"><span style="color:#3fb950">&#128176; Valores</span></div>';
    h += '<div class="full-section-body"><div class="m-grid">';
    h += '<div class="m-field"><div class="lbl">Valor da Causa</div><div class="val val-big val-orange">' + fmt(p.valor_causa) + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Valor Condenacao</div><div class="val val-big val-red">' + fmt(p.valor_condenacao) + '</div></div>';
    if (p.valor_acordo) h += '<div class="m-field"><div class="lbl">Valor Acordo</div><div class="val val-big val-green">' + fmt(p.valor_acordo) + '</div></div>';
    if (p.valor_bloqueado) h += '<div class="m-field"><div class="lbl">Valor Bloqueado</div><div class="val val-big val-red">' + fmt(p.valor_bloqueado) + '</div></div>';
    if (p.valor_liquido_execucao) h += '<div class="m-field"><div class="lbl">Valor Liq. Execucao</div><div class="val val-big val-red">' + fmt(p.valor_liquido_execucao) + '</div></div>';
    h += '</div></div></div>';

    // ALL MOVIMENTACOES DATAJUD (com filtro)
    const movs = p.datajud_movimentos_all || [];
    const sentencas = movs.filter(m => m.isSentenca || (m.nome||'').toLowerCase().match(/senten|acordao|decisão|decisao|despacho|julgamento/));
    h += '<div class="full-section"><div class="full-section-hdr" onclick="toggleNext(this)">';
    h += '<span style="color:#58a6ff">&#128752; TODAS as Movimentacoes DataJud (' + movs.length + ')</span><span style="color:#484f58">&#9660;</span></div>';
    h += '<div class="full-section-body" style="padding:0">';

    // Filtros
    h += '<div class="full-filter" style="padding:12px 18px 0">';
    h += '<button class="active" onclick="filterMovs(\\'all\\',this)">Todas (' + movs.length + ')</button>';
    h += '<button onclick="filterMovs(\\'sentenca\\',this)">Sentencas/Decisoes (' + sentencas.length + ')</button>';
    const graus = [...new Set(movs.map(m => m.grau).filter(Boolean))];
    graus.forEach(g => {
      const ct = movs.filter(m => m.grau === g).length;
      h += '<button onclick="filterMovs(\\''+g+'\\',this)">' + esc(g) + ' (' + ct + ')</button>';
    });
    h += '</div>';

    h += '<div id="movsContainer">';
    movs.forEach((m, i) => {
      const isSent = m.isSentenca || (m.nome||'').toLowerCase().match(/senten|acordao|decisão|decisao|julgamento/);
      h += '<div class="full-mov' + (isSent ? ' sentenca' : '') + '" data-grau="' + esc(m.grau||'') + '" data-sent="' + (isSent?'1':'0') + '">';
      h += '<div class="full-mov-date">' + esc(m.data||'') + (m.grau ? '<span class="full-mov-grau">' + esc(m.grau) + '</span>' : '') + '</div>';
      h += '<div><div class="full-mov-desc">' + esc(m.nome||'') + '</div>';
      if (m.complementos && m.complementos.length) {
        h += '<div class="full-mov-comp">';
        m.complementos.forEach(c => { h += esc((c.valor||c.descricao||c.nome||'')) + ' '; });
        h += '</div>';
      }
      if (m.orgao) h += '<div class="full-mov-comp">' + esc(m.orgao) + '</div>';
      h += '</div></div>';
    });
    h += '</div></div></div>';

    // ALL INTIMACOES COM TEXTO COMPLETO
    const comms = p.comunicacoes_all || [];
    h += '<div class="full-section"><div class="full-section-hdr" onclick="toggleNext(this)">';
    h += '<span style="color:#f0883e">&#9889; TODAS as Intimacoes PJe (' + comms.length + ') - TEXTO COMPLETO</span><span style="color:#484f58">&#9660;</span></div>';
    h += '<div class="full-section-body" style="padding:0">';
    if (comms.length === 0) {
      h += '<div style="padding:20px;text-align:center;color:#484f58">Nenhuma comunicacao encontrada no Comunica PJe</div>';
    }
    comms.forEach((c, i) => {
      const isUrgent = c.parsed?.urgente;
      h += '<div class="full-intim" style="' + (isUrgent ? 'border-left:3px solid #f85149;background:rgba(248,81,73,.04)' : '') + '">';
      h += '<div class="full-intim-hdr">';
      h += '<div><span style="color:#58a6ff;font-weight:700">' + esc(c.data||'') + '</span>';
      h += ' <span style="color:#8b949e">' + esc(c.tipo||'') + '</span>';
      h += ' <span style="color:#bc8cff;font-size:.75rem">' + esc(c.orgao||'') + '</span>';
      if (c.parsed?.tipo_decisao) h += ' <span class="acao-badge acao-' + (isUrgent?'vermelho':'azul') + '">' + esc(c.parsed.tipo_decisao) + '</span>';
      if (c.parsed?.prazo_dias) h += ' <span class="acao-badge acao-laranja">Prazo: ' + c.parsed.prazo_dias + 'd</span>';
      h += '</div>';
      if (c.link) h += '<a href="' + esc(c.link) + '" target="_blank" style="color:#58a6ff;font-size:.78rem;text-decoration:none;background:rgba(88,166,255,.1);padding:4px 10px;border-radius:6px">Ver no PJe</a>';
      h += '</div>';
      if (c.destinatarios?.length) h += '<div style="font-size:.72rem;color:#484f58;margin-bottom:6px">Para: ' + c.destinatarios.map(d => esc(d)).join(', ') + '</div>';
      // Texto completo com toggle
      if (c.texto_completo) {
        h += '<div style="margin-top:6px"><button onclick="toggleText(this)" style="background:rgba(88,166,255,.1);border:1px solid rgba(88,166,255,.2);color:#58a6ff;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:.75rem">&#9660; Ver texto completo</button>';
        h += '<div class="full-intim-texto" style="display:none">' + esc(c.texto_completo) + '</div></div>';
      } else if (c.parsed?.conteudo_resumido) {
        h += '<div style="font-size:.78rem;color:#8b949e;margin-top:4px">' + esc(c.parsed.conteudo_resumido) + '</div>';
      }
      h += '</div>';
    });
    h += '</div></div>';

    // DADOS DO PROCESSO
    h += '<div class="full-section"><div class="full-section-hdr" onclick="toggleNext(this)">';
    h += '<span style="color:#8b949e">&#128196; Dados Cadastrais</span><span style="color:#484f58">&#9660;</span></div>';
    h += '<div class="full-section-body"><div class="m-grid">';
    h += '<div class="m-field"><div class="lbl">Tipo</div><div class="val">' + esc(p.tipo||'') + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Grau</div><div class="val">' + esc(p.grau||'') + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Tribunal</div><div class="val">' + esc(p.tribunal||'') + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Vara</div><div class="val">' + esc(p.vara||'') + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Cidade</div><div class="val">' + esc(p.cidade||'') + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Autuacao</div><div class="val">' + esc(p.data_autuacao||'') + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Status</div><div class="val">' + esc(p.status||'') + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Fase</div><div class="val">' + esc(p.fase||'') + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Resultado Burlington</div><div class="val">' + esc(p.resultado_burlington||'Pendente') + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Resultado FRRamos</div><div class="val">' + esc(p.resultado_frramos||'N/A') + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Desc. PJ Burlington</div><div class="val">' + yn(p.desconsideracao_pj_burlington) + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Desc. PJ FRRamos</div><div class="val">' + yn(p.desconsideracao_pj_frramos) + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Burlington Revel</div><div class="val">' + yn(p.burlington_revel) + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Bloqueio PJ</div><div class="val">' + yn(p.pedido_bloqueio_conta_pj) + '</div></div>';
    h += '<div class="m-field"><div class="lbl">Penhora Veiculo</div><div class="val">' + yn(p.pedido_automovel) + '</div></div>';
    h += '</div></div></div>';

    h += '</div>'; // modal-body
    document.getElementById('modalContent').innerHTML = h;
  } catch(e) {
    alert('Erro ao buscar processo full: ' + e.message);
    if (btn) { btn.classList.remove('loading'); btn.innerHTML = '&#128269; Processo Full'; }
  }
}

function filterMovs(type, el) {
  document.querySelectorAll('.full-filter button').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('#movsContainer .full-mov').forEach(m => {
    if (type === 'all') { m.style.display = ''; }
    else if (type === 'sentenca') { m.style.display = m.dataset.sent === '1' ? '' : 'none'; }
    else { m.style.display = m.dataset.grau === type ? '' : 'none'; }
  });
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('show');
  document.body.style.overflow = '';
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// === UPDATE ===
async function startUpdate() {
  const btn = document.getElementById('btnUpdate');
  btn.disabled = true;
  btn.classList.add('running');
  btn.innerHTML = '&#9203; Atualizando...';

  document.getElementById('progWrap').classList.add('show');

  try {
    await fetch('/api/atualizar', { method: 'POST' });
    startPolling();
  } catch (e) {
    btn.disabled = false;
    btn.classList.remove('running');
    btn.innerHTML = '&#128259; Atualizar Agora';
    alert('Erro ao iniciar atualização: ' + e.message);
  }
}

function startPolling() {
  if (pollInterval) return;
  const btn = document.getElementById('btnUpdate');
  btn.disabled = true;
  btn.classList.add('running');
  btn.innerHTML = '&#9203; Atualizando...';
  document.getElementById('progWrap').classList.add('show');

  pollInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/progress');
      const data = await res.json();

      if (data.running) {
        const pct = data.total > 0 ? Math.round((data.progress / data.total) * 100) : 0;
        document.getElementById('progFill').style.width = pct + '%';
        document.getElementById('progText').textContent = data.progress + '/' + data.total + ' - ' + data.currentProcess;
        document.getElementById('progPct').textContent = pct + '%';

        // Update log
        const logEl = document.getElementById('logPanel');
        if (logEl.classList.contains('show')) {
          logEl.innerHTML = data.log.map(l => '<div class="log-entry"><span class="time">' + l.time.substring(11, 19) + '</span> ' + esc(l.msg) + '</div>').join('');
          logEl.scrollTop = logEl.scrollHeight;
        }
      } else {
        // Done
        clearInterval(pollInterval);
        pollInterval = null;
        document.getElementById('progFill').style.width = '100%';
        document.getElementById('progText').textContent = 'Concluido!';
        document.getElementById('progPct').textContent = '100%';

        btn.disabled = false;
        btn.classList.remove('running');
        btn.innerHTML = '&#128259; Atualizar Agora';

        setTimeout(() => {
          document.getElementById('progWrap').classList.remove('show');
          loadData();
        }, 2000);
      }
    } catch (e) {
      console.error('Poll error:', e);
    }
  }, 1500);
}

async function startComunicaUpdate() {
  const btn = document.getElementById('btnComunica');
  btn.disabled = true;
  btn.innerHTML = '&#9203; Consultando PJe...';
  btn.style.opacity = '0.6';
  try {
    await fetch('/api/comunicacoes/atualizar', { method: 'POST' });
    // Comunica takes ~4min for 64 processes, show message
    const logEl = document.getElementById('logPanel');
    logEl.classList.add('show');
    logEl.innerHTML = '<div class="log-entry">Consulta Comunica PJe iniciada (~4 min para 64 processos, rate limit 20/min). Recarregue a pagina quando concluir.</div>';
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = '&#9889; Comunica PJe (Tempo Real)';
      btn.style.opacity = '1';
      loadData();
    }, 240000); // 4 minutes
  } catch(e) {
    btn.disabled = false;
    btn.innerHTML = '&#9889; Comunica PJe (Tempo Real)';
    btn.style.opacity = '1';
  }
}

function toggleLog() {
  document.getElementById('logPanel').classList.toggle('show');
}

// === SORTING ===
document.querySelectorAll('.upd-table th').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.getAttribute('data-sort');
    if (col === sortCol) sortDir *= -1;
    else { sortCol = col; sortDir = 1; }
    renderTable();
  });
});

// === SEARCH ===
document.getElementById('searchInput').addEventListener('input', renderTable);

// === HELPERS ===
function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function truncate(s, n) { if (!s) return ''; return s.length > n ? s.substring(0, n) + '...' : s; }

function formatDateTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
}

function getDateClass(dateStr) {
  if (!dateStr || dateStr === '--') return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = (now - d) / (1000 * 60 * 60 * 24);
  if (diff <= 30) return 'dt-recent';
  if (diff <= 90) return 'dt-old';
  return 'dt-stale';
}

function riskBg(r) {
  if (!r) return '';
  const rl = r.toLowerCase();
  if (rl.includes('crit')) return '<span class="bg bg-r">' + esc(r) + '</span>';
  if (rl.includes('alt')) return '<span class="bg bg-o">' + esc(r) + '</span>';
  if (rl.includes('med') || rl.includes('mod')) return '<span class="bg bg-y">' + esc(r) + '</span>';
  return '<span class="bg bg-g">' + esc(r) + '</span>';
}

function priorBg(p) {
  if (!p) return '';
  const pl = p.toLowerCase();
  if (pl.includes('crit') || pl.includes('maxim') || pl.includes('urgent')) return '<span class="bg bg-r">' + esc(p) + '</span>';
  if (pl.includes('alta')) return '<span class="bg bg-o">' + esc(p) + '</span>';
  if (pl.includes('med')) return '<span class="bg bg-y">' + esc(p) + '</span>';
  return '<span class="bg bg-g">' + esc(p) + '</span>';
}

// Helpers
function toggleNext(el) { var s = el.nextElementSibling.style; s.display = s.display === 'none' ? '' : 'none'; }
function toggleText(btn) { var t = btn.nextElementSibling; if (t.style.display === 'none') { t.style.display = ''; btn.innerHTML = '&#9650; Ocultar texto'; } else { t.style.display = 'none'; btn.innerHTML = '&#9660; Ver texto completo'; } }

// Scroll
function goTo(id) { document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'}); }
window.addEventListener('scroll', () => { document.getElementById('btt').classList.toggle('vis', window.scrollY > 400); });
</script>
</body>
</html>`;
}

// === ASTREA INTERFACE ===
function generateAstreaHTML() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Burlington Legal - Astrea</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Segoe UI', 'Roboto', -apple-system, sans-serif; background: #f5f5f5; color: #212121; }
a { color: #1976d2; text-decoration: none; }
a:hover { text-decoration: underline; }

/* Layout */
.app-container { display: flex; height: 100vh; overflow: hidden; }
.sidebar { width: 240px; background: #fff; border-right: 1px solid #e0e0e0; display: flex; flex-direction: column; }
.main-content { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.topbar { height: 64px; background: #fff; border-bottom: 1px solid #e0e0e0; display: flex; align-items: center; padding: 0 24px; gap: 16px; }
.content-area { flex: 1; overflow-y: auto; padding: 24px; }

/* Sidebar */
.sidebar-logo { padding: 20px; font-size: 18px; font-weight: 600; color: #1976d2; border-bottom: 1px solid #e0e0e0; }
.sidebar-nav { flex: 1; padding: 8px 0; }
.nav-item { display: flex; align-items: center; gap: 12px; padding: 12px 20px; cursor: pointer; transition: background .2s; color: #616161; font-size: 14px; }
.nav-item:hover { background: #f5f5f5; }
.nav-item.active { background: #e3f2fd; color: #1976d2; font-weight: 500; border-right: 3px solid #1976d2; }
.nav-icon { font-size: 20px; width: 24px; text-align: center; }

/* Topbar */
.search-box { flex: 1; max-width: 500px; }
.search-box input { width: 100%; padding: 8px 16px; border: 1px solid #e0e0e0; border-radius: 8px; font-size: 14px; }
.search-box input:focus { outline: none; border-color: #1976d2; }
.user-info { display: flex; align-items: center; gap: 8px; color: #757575; font-size: 14px; }

/* Cards */
.card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.12); margin-bottom: 16px; }
.card-header { padding: 16px 20px; border-bottom: 1px solid #e0e0e0; font-weight: 600; font-size: 16px; color: #212121; }
.card-body { padding: 20px; }

/* Filter chips */
.filter-chips { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.chip { padding: 6px 16px; border-radius: 16px; font-size: 13px; cursor: pointer; transition: all .2s; border: 1px solid #e0e0e0; background: #fff; color: #616161; }
.chip:hover { background: #f5f5f5; }
.chip.active { background: #1976d2; color: #fff; border-color: #1976d2; }

/* Table */
.table-container { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; background: #fff; }
thead { background: #fafafa; border-bottom: 2px solid #e0e0e0; }
th { text-align: left; padding: 12px 16px; font-weight: 600; font-size: 13px; color: #616161; text-transform: uppercase; letter-spacing: .5px; }
td { padding: 12px 16px; border-bottom: 1px solid #f5f5f5; font-size: 14px; }
tbody tr { cursor: pointer; transition: background .15s; }
tbody tr:hover { background: #fafafa; }

/* Tags/Badges */
.tag { display: inline-block; padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 500; margin-right: 4px; margin-bottom: 4px; }
.tag-blue { background: #e3f2fd; color: #1565c0; }
.tag-red { background: #ffebee; color: #c62828; }
.tag-green { background: #e8f5e9; color: #2e7d32; }
.tag-orange { background: #fff3e0; color: #e65100; }
.tag-gray { background: #f5f5f5; color: #616161; }

/* Process detail */
.process-header { margin-bottom: 24px; }
.process-title { font-size: 24px; font-weight: 600; margin-bottom: 12px; color: #212121; }
.process-info-line { font-size: 14px; color: #757575; margin-bottom: 8px; }
.process-tags { margin-top: 12px; }

/* Tabs */
.tabs { display: flex; gap: 24px; border-bottom: 2px solid #e0e0e0; margin-bottom: 24px; }
.tab { padding: 12px 0; cursor: pointer; color: #757575; font-weight: 500; font-size: 14px; border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all .2s; }
.tab:hover { color: #212121; }
.tab.active { color: #1976d2; border-bottom-color: #1976d2; }

/* Detail layout */
.detail-layout { display: grid; grid-template-columns: 1fr 320px; gap: 24px; }
.detail-main { display: flex; flex-direction: column; gap: 16px; }
.detail-sidebar { display: flex; flex-direction: column; gap: 16px; }

/* Info grid */
.info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.info-item { margin-bottom: 12px; }
.info-label { font-size: 12px; color: #757575; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; font-weight: 600; }
.info-value { font-size: 14px; color: #212121; }

/* Timeline */
.timeline { position: relative; padding-left: 32px; }
.timeline-item { position: relative; padding-bottom: 24px; }
.timeline-item::before { content: ''; position: absolute; left: -27px; top: 6px; width: 10px; height: 10px; border-radius: 50%; background: #1976d2; border: 2px solid #fff; box-shadow: 0 0 0 2px #e3f2fd; }
.timeline-item::after { content: ''; position: absolute; left: -23px; top: 16px; bottom: -8px; width: 2px; background: #e0e0e0; }
.timeline-item:last-child::after { display: none; }
.timeline-date { font-size: 12px; color: #757575; font-weight: 600; margin-bottom: 4px; }
.timeline-content { font-size: 14px; color: #212121; line-height: 1.5; }

/* Stats */
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
.stat-card { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
.stat-value { font-size: 32px; font-weight: 600; color: #212121; margin-bottom: 4px; }
.stat-label { font-size: 14px; color: #757575; }
.stat-change { font-size: 12px; margin-top: 8px; }
.stat-change.positive { color: #2e7d32; }
.stat-change.negative { color: #c62828; }

/* Empty state */
.empty-state { text-align: center; padding: 60px 20px; color: #9e9e9e; }
.empty-state-icon { font-size: 64px; margin-bottom: 16px; }
.empty-state-text { font-size: 16px; }

/* Loading */
.loading { text-align: center; padding: 40px; color: #757575; }

/* Alert box */
.alert { padding: 12px 16px; border-radius: 6px; margin-bottom: 12px; font-size: 14px; }
.alert-warning { background: #fff3e0; border-left: 4px solid #f57c00; color: #e65100; }
.alert-danger { background: #ffebee; border-left: 4px solid #d32f2f; color: #c62828; }
.alert-success { background: #e8f5e9; border-left: 4px solid #388e3c; color: #2e7d32; }
.alert-info { background: #e3f2fd; border-left: 4px solid #1976d2; color: #1565c0; }

/* Responsive */
@media (max-width: 1024px) {
  .detail-layout { grid-template-columns: 1fr; }
  .detail-sidebar { order: -1; }
}
@media (max-width: 768px) {
  .sidebar { width: 200px; }
  .info-grid { grid-template-columns: 1fr; }
}

/* Utilities */
.hidden { display: none !important; }
.text-muted { color: #757575; }
.text-primary { color: #1976d2; }
.text-danger { color: #c62828; }
.text-success { color: #2e7d32; }
.font-weight-bold { font-weight: 600; }
.mb-0 { margin-bottom: 0; }
.mt-2 { margin-top: 8px; }
.mb-2 { margin-bottom: 8px; }
</style>
</head>
<body>
<div class="app-container">
  <!-- Sidebar -->
  <div class="sidebar">
    <div class="sidebar-logo">Burlington Legal</div>
    <div class="sidebar-nav">
      <div class="nav-item" onclick="showView('dashboard')">
        <span class="nav-icon">&#128200;</span>
        <span>Area de trabalho</span>
      </div>
      <div class="nav-item active" onclick="showView('processos')">
        <span class="nav-icon">&#128194;</span>
        <span>Processos e casos</span>
      </div>
      <div class="nav-item" onclick="showView('publicacoes')">
        <span class="nav-icon">&#128240;</span>
        <span>Publicacoes</span>
      </div>
      <div class="nav-item" onclick="showView('contatos')">
        <span class="nav-icon">&#128101;</span>
        <span>Contatos</span>
      </div>
      <div class="nav-item" onclick="showView('indicadores')">
        <span class="nav-icon">&#128202;</span>
        <span>Indicadores</span>
      </div>
      <div class="nav-item" onclick="showView('alertas')">
        <span class="nav-icon">&#9888;</span>
        <span>Alertas</span>
      </div>
    </div>
  </div>

  <!-- Main content -->
  <div class="main-content">
    <!-- Topbar -->
    <div class="topbar">
      <div class="search-box">
        <input type="text" id="globalSearch" placeholder="Buscar processos, partes, numeros..." onkeyup="handleGlobalSearch()">
      </div>
      <div class="user-info">
        <span>&#128100;</span>
        <span>Christiane Bendini</span>
      </div>
    </div>

    <!-- Content area -->
    <div class="content-area">
      <!-- Dashboard View -->
      <div id="view-dashboard" class="view-content hidden">
        <h2 style="margin-bottom: 24px;">Area de trabalho</h2>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-value" id="dash-total">0</div>
            <div class="stat-label">Total de processos</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="dash-ativos">0</div>
            <div class="stat-label">Processos ativos</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="dash-risco">0</div>
            <div class="stat-label">Alto risco</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="dash-valor">R$ 0</div>
            <div class="stat-label">Valor total causa</div>
          </div>
        </div>
        <div class="card" style="margin-top: 24px;">
          <div class="card-header">Atividades recentes</div>
          <div class="card-body">
            <div id="dash-activities" class="loading">Carregando...</div>
          </div>
        </div>
      </div>

      <!-- Processos List View -->
      <div id="view-processos" class="view-content">
        <div class="filter-chips">
          <div class="chip active" onclick="filterProcessos('todos')">Todos</div>
          <div class="chip" onclick="filterProcessos('ativos')">Ativos</div>
          <div class="chip" onclick="filterProcessos('execucao')">Execucao</div>
          <div class="chip" onclick="filterProcessos('alto-risco')">Alto Risco</div>
          <div class="chip" onclick="filterProcessos('ganha')">Causa Ganha</div>
        </div>
        <div class="card">
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Processo</th>
                  <th>Partes</th>
                  <th>Acao</th>
                  <th>Juizo</th>
                  <th>Valor Causa</th>
                  <th>Status</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody id="processos-tbody">
                <tr><td colspan="7" class="loading">Carregando processos...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Process Detail View -->
      <div id="view-processo-detail" class="view-content hidden">
        <div class="process-header">
          <div style="margin-bottom: 12px;">
            <a href="#" onclick="showView('processos'); return false;" style="color: #1976d2; font-size: 14px;">&#8592; Voltar para lista</a>
          </div>
          <h1 class="process-title" id="detail-title">Carregando...</h1>
          <div class="process-tags" id="detail-tags"></div>
          <div class="process-info-line" id="detail-info"></div>
        </div>

        <div class="tabs">
          <div class="tab active" onclick="switchTab('resumo')">Resumo</div>
          <div class="tab" onclick="switchTab('atividades')">Atividades</div>
          <div class="tab" onclick="switchTab('historico')">Historico</div>
        </div>

        <!-- Tab: Resumo -->
        <div id="tab-resumo" class="tab-content">
          <div class="detail-layout">
            <div class="detail-main">
              <div class="card">
                <div class="card-header">Dados do Processo</div>
                <div class="card-body">
                  <div class="info-grid" id="detail-dados"></div>
                </div>
              </div>
              <div class="card">
                <div class="card-header">Estrategia e Recomendacoes</div>
                <div class="card-body" id="detail-estrategia"></div>
              </div>
            </div>
            <div class="detail-sidebar">
              <div class="card">
                <div class="card-header">Proximas atividades</div>
                <div class="card-body" id="detail-proximas"></div>
              </div>
              <div class="card">
                <div class="card-header">Alertas</div>
                <div class="card-body" id="detail-alertas"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- Tab: Atividades -->
        <div id="tab-atividades" class="tab-content hidden">
          <div class="card">
            <div class="card-header">Timeline de atividades</div>
            <div class="card-body">
              <div class="timeline" id="detail-timeline"></div>
            </div>
          </div>
        </div>

        <!-- Tab: Historico -->
        <div id="tab-historico" class="tab-content hidden">
          <div class="card">
            <div class="card-header">Historico completo (DataJud + Local)</div>
            <div class="card-body">
              <div class="timeline" id="detail-historico-full"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Publicacoes View -->
      <div id="view-publicacoes" class="view-content hidden">
        <h2 style="margin-bottom: 24px;">Publicacoes (Comunica PJe)</h2>
        <div id="publicacoes-list"></div>
      </div>

      <!-- Contatos View -->
      <div id="view-contatos" class="view-content hidden">
        <h2 style="margin-bottom: 24px;">Contatos</h2>
        <div class="card">
          <div class="card-body">
            <div id="contatos-list"></div>
          </div>
        </div>
      </div>

      <!-- Indicadores View -->
      <div id="view-indicadores" class="view-content hidden">
        <h2 style="margin-bottom: 24px;">Indicadores</h2>
        <div class="stats-grid" id="indicadores-stats"></div>
      </div>

      <!-- Alertas View -->
      <div id="view-alertas" class="view-content hidden">
        <h2 style="margin-bottom: 24px;">Alertas</h2>
        <div id="alertas-list"></div>
      </div>
    </div>
  </div>
</div>

<script>
// Global state
let allProcessos = [];
let currentFilter = 'todos';
let currentProcessoId = null;

// Helpers
function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function formatCurrency(val) { if (!val) return 'R$ 0,00'; return 'R$ ' + Number(val).toLocaleString('pt-BR', {minimumFractionDigits: 2}); }
function formatDate(d) { if (!d) return '--'; return new Date(d).toLocaleDateString('pt-BR'); }

// Navigation
function showView(viewName) {
  document.querySelectorAll('.view-content').forEach(function(el) { el.classList.add('hidden'); });
  document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });

  var viewEl = document.getElementById('view-' + viewName);
  if (viewEl) viewEl.classList.remove('hidden');

  var navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(function(item) {
    if (item.textContent.toLowerCase().includes(viewName === 'processos' ? 'processos' : viewName === 'dashboard' ? 'trabalho' : viewName)) {
      item.classList.add('active');
    }
  });

  if (viewName === 'dashboard') loadDashboard();
  if (viewName === 'publicacoes') loadPublicacoes();
  if (viewName === 'contatos') loadContatos();
  if (viewName === 'indicadores') loadIndicadores();
  if (viewName === 'alertas') loadAlertas();
}

// Tab switching
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(function(el) { el.classList.remove('active'); });
  document.querySelectorAll('.tab-content').forEach(function(el) { el.classList.add('hidden'); });

  event.target.classList.add('active');
  document.getElementById('tab-' + tabName).classList.remove('hidden');
}

// Load processos
function loadProcessos() {
  fetch('/api/status')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      allProcessos = data.processos || [];
      renderProcessosTable();
    })
    .catch(function(e) {
      document.getElementById('processos-tbody').innerHTML = '<tr><td colspan="7" style="color: #c62828;">Erro ao carregar: ' + esc(e.message) + '</td></tr>';
    });
}

function filterProcessos(filter) {
  currentFilter = filter;
  document.querySelectorAll('.filter-chips .chip').forEach(function(el) { el.classList.remove('active'); });
  event.target.classList.add('active');
  renderProcessosTable();
}

function renderProcessosTable() {
  var filtered = allProcessos.filter(function(p) {
    if (currentFilter === 'todos') return true;
    if (currentFilter === 'ativos') return (p.status || '').toLowerCase().includes('ativo') || (p.fase || '').toLowerCase().includes('conhecimento');
    if (currentFilter === 'execucao') return (p.fase || '').toLowerCase().includes('execu');
    if (currentFilter === 'alto-risco') return (p.risco || '').toLowerCase().includes('alt') || (p.risco || '').toLowerCase().includes('crit');
    if (currentFilter === 'ganha') return p.causa_ganha_burlington || p.causa_ganha_frramos;
    return true;
  });

  var html = '';
  filtered.forEach(function(p) {
    var tags = '<span class="tag tag-blue">BURLINGTON ENGLISH LATAM</span>';
    if (p.envolve_frramos) tags += '<span class="tag tag-red">F R RAMOS</span>';
    tags += '<span class="tag tag-green">TRABALHISTA</span>';

    var riscoCor = 'gray';
    var riscoLower = (p.risco || '').toLowerCase();
    if (riscoLower.includes('crit')) riscoCor = 'red';
    else if (riscoLower.includes('alt')) riscoCor = 'orange';
    else if (riscoLower.includes('med')) riscoCor = 'orange';

    html += '<tr onclick="loadProcessoDetail(' + p.id + ')">' +
      '<td><a href="#" onclick="event.preventDefault(); loadProcessoDetail(' + p.id + ');">' + esc(p.numero) + '</a></td>' +
      '<td>' + esc(p.reclamante) + '</td>' +
      '<td>' + esc(p.acao_recomendada || p.fase || '--') + '</td>' +
      '<td>' + esc(p.vara || '--') + '</td>' +
      '<td>' + formatCurrency(p.valor_causa) + '</td>' +
      '<td><span class="tag tag-' + riscoCor + '">' + esc(p.status || 'Em andamento') + '</span></td>' +
      '<td>' + tags + '</td>' +
    '</tr>';
  });

  if (html === '') html = '<tr><td colspan="7" class="empty-state-text">Nenhum processo encontrado</td></tr>';
  document.getElementById('processos-tbody').innerHTML = html;
}

// Global search
function handleGlobalSearch() {
  var query = document.getElementById('globalSearch').value.toLowerCase();
  if (query.length < 2) {
    renderProcessosTable();
    return;
  }

  var filtered = allProcessos.filter(function(p) {
    return (p.numero || '').toLowerCase().includes(query) ||
           (p.reclamante || '').toLowerCase().includes(query) ||
           (p.vara || '').toLowerCase().includes(query);
  });

  allProcessos = filtered;
  renderProcessosTable();
}

// Load processo detail
function loadProcessoDetail(id) {
  currentProcessoId = id;
  showView('processo-detail');

  document.getElementById('detail-title').textContent = 'Carregando...';
  document.getElementById('detail-tags').innerHTML = '';
  document.getElementById('detail-info').innerHTML = '';
  document.getElementById('detail-dados').innerHTML = '<div class="loading">Carregando dados...</div>';

  fetch('/api/processo/' + id)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      renderProcessoDetail(data);
    })
    .catch(function(e) {
      document.getElementById('detail-dados').innerHTML = '<div style="color: #c62828;">Erro: ' + esc(e.message) + '</div>';
    });
}

function renderProcessoDetail(p) {
  var title = esc(p.reclamante) + ' X BURLINGTON ENGLISH LATAM';
  if (p.envolve_frramos) title += ' / F R RAMOS';
  document.getElementById('detail-title').textContent = title;

  var tags = '<span class="tag tag-blue">BURLINGTON ENGLISH LATAM</span>';
  if (p.envolve_frramos) tags += '<span class="tag tag-red">F R RAMOS</span>';
  tags += '<span class="tag tag-green">TRABALHISTA</span>';
  document.getElementById('detail-tags').innerHTML = tags;

  var info = 'Processo: ' + esc(p.numero) + ' | Cliente: MINDSET INSTITUTE LTDA | Status: ' + esc(p.status || 'Em andamento') + ' | Responsavel: Christiane Bendini';
  document.getElementById('detail-info').innerHTML = info;

  var dadosHtml = '';
  dadosHtml += '<div class="info-item"><div class="info-label">Acao</div><div class="info-value">' + esc(p.tipo || '--') + '</div></div>';
  dadosHtml += '<div class="info-item"><div class="info-label">Objeto</div><div class="info-value">Verbas trabalhistas</div></div>';
  dadosHtml += '<div class="info-item"><div class="info-label">Numero</div><div class="info-value">' + esc(p.numero) + '</div></div>';
  dadosHtml += '<div class="info-item"><div class="info-label">Juizo</div><div class="info-value">' + esc(p.vara || '--') + '</div></div>';
  dadosHtml += '<div class="info-item"><div class="info-label">Valor da causa</div><div class="info-value">' + formatCurrency(p.valor_causa) + '</div></div>';
  dadosHtml += '<div class="info-item"><div class="info-label">Val. condenacao</div><div class="info-value">' + formatCurrency(p.valor_condenacao) + '</div></div>';
  dadosHtml += '<div class="info-item"><div class="info-label">Distribuido em</div><div class="info-value">' + formatDate(p.data_autuacao) + '</div></div>';
  dadosHtml += '<div class="info-item"><div class="info-label">Criado em</div><div class="info-value">' + formatDate(p.data_autuacao) + '</div></div>';
  dadosHtml += '<div class="info-item"><div class="info-label">Fase</div><div class="info-value">' + esc(p.fase || '--') + '</div></div>';
  dadosHtml += '<div class="info-item"><div class="info-label">Grau</div><div class="info-value">' + esc(p.grau || 'G1') + '</div></div>';
  document.getElementById('detail-dados').innerHTML = dadosHtml;

  var estrategiaHtml = '';
  if (p.estrategia && p.estrategia.length > 0) {
    p.estrategia.forEach(function(est) {
      var alertClass = 'alert-info';
      var estLower = est.toLowerCase();
      if (estLower.includes('urgente') || estLower.includes('bloqueio') || estLower.includes('critica')) alertClass = 'alert-danger';
      else if (estLower.includes('risco') || estLower.includes('audiencia')) alertClass = 'alert-warning';
      else if (estLower.includes('positivo') || estLower.includes('ganha') || estLower.includes('excluida')) alertClass = 'alert-success';

      estrategiaHtml += '<div class="alert ' + alertClass + '">' + esc(est) + '</div>';
    });
  } else {
    estrategiaHtml = '<div class="text-muted">Nenhuma recomendacao estrategica no momento.</div>';
  }
  document.getElementById('detail-estrategia').innerHTML = estrategiaHtml;

  var proximasHtml = '';
  if (p.proxima_audiencia) {
    var audData = typeof p.proxima_audiencia === 'object' ? p.proxima_audiencia.data : p.proxima_audiencia;
    proximasHtml = '<div class="alert alert-warning"><strong>Audiencia:</strong> ' + esc(audData) + '</div>';
  } else if (p.prazo_final) {
    proximasHtml = '<div class="alert alert-info"><strong>Prazo:</strong> ' + formatDate(p.prazo_final) + '<br>' + esc(p.prazo_descricao || '') + '</div>';
  } else {
    proximasHtml = '<div class="text-muted">Nenhuma atividade proxima agendada.</div>';
  }
  document.getElementById('detail-proximas').innerHTML = proximasHtml;

  var alertasHtml = '';
  if (p.desconsideracao_pj_burlington) alertasHtml += '<div class="alert alert-danger">Desconsideracao PJ Burlington deferida</div>';
  if (p.desconsideracao_pj_frramos) alertasHtml += '<div class="alert alert-danger">Desconsideracao PJ F R Ramos deferida</div>';
  if (p.pedido_bloqueio_conta_pj) alertasHtml += '<div class="alert alert-warning">Pedido de bloqueio bancario PJ</div>';
  if (p.pedido_bloqueio_conta_socios) alertasHtml += '<div class="alert alert-warning">Pedido de bloqueio bancario socios</div>';
  if (p.burlington_revel) alertasHtml += '<div class="alert alert-danger">Burlington REVEL</div>';
  if (alertasHtml === '') alertasHtml = '<div class="text-muted">Nenhum alerta critico.</div>';
  document.getElementById('detail-alertas').innerHTML = alertasHtml;

  var timelineHtml = '';
  if (p.comunicacoes && p.comunicacoes.length > 0) {
    p.comunicacoes.forEach(function(com) {
      timelineHtml += '<div class="timeline-item">' +
        '<div class="timeline-date">' + formatDate(com.data) + '</div>' +
        '<div class="timeline-content"><strong>' + esc(com.tipo) + '</strong><br>' + esc(com.parsed.conteudo_resumido || '') + '</div>' +
      '</div>';
    });
  }
  if (p.historico_movimentacoes && p.historico_movimentacoes.length > 0) {
    p.historico_movimentacoes.slice(0, 5).forEach(function(mov) {
      timelineHtml += '<div class="timeline-item">' +
        '<div class="timeline-date">' + formatDate(mov.data) + '</div>' +
        '<div class="timeline-content">' + esc(mov.descricao) + '</div>' +
      '</div>';
    });
  }
  if (timelineHtml === '') timelineHtml = '<div class="text-muted">Nenhuma atividade registrada.</div>';
  document.getElementById('detail-timeline').innerHTML = timelineHtml;

  loadHistoricoFull(p.id);
}

function loadHistoricoFull(id) {
  document.getElementById('detail-historico-full').innerHTML = '<div class="loading">Carregando historico completo...</div>';

  fetch('/api/processo/' + id + '/full')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var html = '';
      var allMovs = [];

      if (data.datajud_movimentos && data.datajud_movimentos.length > 0) {
        data.datajud_movimentos.forEach(function(mov) {
          allMovs.push({ data: mov.dataHora, desc: mov.nome, fonte: 'DataJud' });
        });
      }

      var p = allProcessos.find(function(x) { return x.id === id; });
      if (p && p.historico_movimentacoes) {
        p.historico_movimentacoes.forEach(function(mov) {
          allMovs.push({ data: mov.data, desc: mov.descricao, fonte: 'Local' });
        });
      }

      allMovs.sort(function(a, b) {
        var dateA = new Date(a.data);
        var dateB = new Date(b.data);
        return dateB - dateA;
      });

      allMovs.forEach(function(mov) {
        html += '<div class="timeline-item">' +
          '<div class="timeline-date">' + formatDate(mov.data) + ' <span class="text-muted">(' + mov.fonte + ')</span></div>' +
          '<div class="timeline-content">' + esc(mov.desc) + '</div>' +
        '</div>';
      });

      if (html === '') html = '<div class="text-muted">Nenhum historico disponivel.</div>';
      document.getElementById('detail-historico-full').innerHTML = html;
    })
    .catch(function(e) {
      document.getElementById('detail-historico-full').innerHTML = '<div style="color: #c62828;">Erro: ' + esc(e.message) + '</div>';
    });
}

// Dashboard
function loadDashboard() {
  var total = allProcessos.length;
  var ativos = allProcessos.filter(function(p) { return (p.status || '').toLowerCase().includes('ativo'); }).length;
  var risco = allProcessos.filter(function(p) { return (p.risco || '').toLowerCase().includes('alt') || (p.risco || '').toLowerCase().includes('crit'); }).length;
  var valorTotal = allProcessos.reduce(function(sum, p) { return sum + (p.valor_causa || 0); }, 0);

  document.getElementById('dash-total').textContent = total;
  document.getElementById('dash-ativos').textContent = ativos;
  document.getElementById('dash-risco').textContent = risco;
  document.getElementById('dash-valor').textContent = formatCurrency(valorTotal);

  var html = '';
  allProcessos.slice(0, 5).forEach(function(p) {
    html += '<div style="padding: 8px 0; border-bottom: 1px solid #f5f5f5;">' +
      '<strong>' + esc(p.numero) + '</strong> - ' + esc(p.reclamante) +
      '<div class="text-muted" style="font-size: 13px; margin-top: 4px;">' + esc(p.acao_recomendada || p.fase || '--') + '</div>' +
    '</div>';
  });
  document.getElementById('dash-activities').innerHTML = html || '<div class="text-muted">Nenhuma atividade recente.</div>';
}

// Publicacoes
function loadPublicacoes() {
  var html = '';
  allProcessos.forEach(function(p) {
    if (p.comunicacoes && p.comunicacoes.length > 0) {
      p.comunicacoes.forEach(function(com) {
        html += '<div class="card">' +
          '<div class="card-body">' +
            '<div style="display: flex; justify-content: space-between; margin-bottom: 8px;">' +
              '<strong>' + esc(com.tipo) + '</strong>' +
              '<span class="text-muted">' + formatDate(com.data) + '</span>' +
            '</div>' +
            '<div style="margin-bottom: 8px;">' + esc(p.numero) + ' - ' + esc(p.reclamante) + '</div>' +
            '<div class="text-muted" style="font-size: 14px;">' + esc(com.parsed.conteudo_resumido || '') + '</div>' +
          '</div>' +
        '</div>';
      });
    }
  });
  if (html === '') html = '<div class="empty-state"><div class="empty-state-icon">&#128240;</div><div class="empty-state-text">Nenhuma publicacao encontrada</div></div>';
  document.getElementById('publicacoes-list').innerHTML = html;
}

// Contatos
function loadContatos() {
  var contatos = {};
  allProcessos.forEach(function(p) {
    if (p.reclamante) {
      if (!contatos[p.reclamante]) contatos[p.reclamante] = { nome: p.reclamante, processos: [] };
      contatos[p.reclamante].processos.push(p.numero);
    }
    if (p.advogado_reclamante) {
      if (!contatos[p.advogado_reclamante]) contatos[p.advogado_reclamante] = { nome: p.advogado_reclamante, tipo: 'Advogado', processos: [] };
      contatos[p.advogado_reclamante].processos.push(p.numero);
    }
  });

  var html = '<div class="table-container"><table><thead><tr><th>Nome</th><th>Tipo</th><th>Processos</th></tr></thead><tbody>';
  Object.values(contatos).forEach(function(c) {
    html += '<tr>' +
      '<td>' + esc(c.nome) + '</td>' +
      '<td>' + (c.tipo || 'Reclamante') + '</td>' +
      '<td>' + c.processos.length + '</td>' +
    '</tr>';
  });
  html += '</tbody></table></div>';
  document.getElementById('contatos-list').innerHTML = html;
}

// Indicadores
function loadIndicadores() {
  var total = allProcessos.length;
  var execucao = allProcessos.filter(function(p) { return (p.fase || '').toLowerCase().includes('execu'); }).length;
  var ganhos = allProcessos.filter(function(p) { return p.causa_ganha_burlington || p.causa_ganha_frramos; }).length;
  var valorTotal = allProcessos.reduce(function(sum, p) { return sum + (p.valor_causa || 0); }, 0);
  var valorCond = allProcessos.reduce(function(sum, p) { return sum + (p.valor_condenacao || 0); }, 0);

  var html = '';
  html += '<div class="stat-card"><div class="stat-value">' + total + '</div><div class="stat-label">Total processos</div></div>';
  html += '<div class="stat-card"><div class="stat-value">' + execucao + '</div><div class="stat-label">Em execucao</div></div>';
  html += '<div class="stat-card"><div class="stat-value">' + ganhos + '</div><div class="stat-label">Causas ganhas</div></div>';
  html += '<div class="stat-card"><div class="stat-value">' + formatCurrency(valorTotal) + '</div><div class="stat-label">Valor total causa</div></div>';
  html += '<div class="stat-card"><div class="stat-value">' + formatCurrency(valorCond) + '</div><div class="stat-label">Valor condenacao</div></div>';

  document.getElementById('indicadores-stats').innerHTML = html;
}

// Alertas
function loadAlertas() {
  var html = '';
  allProcessos.forEach(function(p) {
    var alerts = [];
    if (p.proxima_audiencia) {
      var audData = typeof p.proxima_audiencia === 'object' ? p.proxima_audiencia.data : p.proxima_audiencia;
      alerts.push({ tipo: 'Audiencia agendada', msg: audData, cor: 'danger' });
    }
    if (p.desconsideracao_pj_burlington) alerts.push({ tipo: 'Desconsideracao PJ Burlington', msg: 'Patrimonio em risco', cor: 'danger' });
    if (p.desconsideracao_pj_frramos) alerts.push({ tipo: 'Desconsideracao PJ F R Ramos', msg: 'Patrimonio em risco', cor: 'danger' });
    if (p.pedido_bloqueio_conta_pj) alerts.push({ tipo: 'Bloqueio bancario PJ', msg: 'Risco SISBAJUD', cor: 'warning' });
    if (p.burlington_revel) alerts.push({ tipo: 'Burlington REVEL', msg: 'Avaliar acao rescisoria', cor: 'danger' });

    if (alerts.length > 0) {
      html += '<div class="card">' +
        '<div class="card-body">' +
          '<strong>' + esc(p.numero) + '</strong> - ' + esc(p.reclamante) +
          '<div style="margin-top: 12px;">';
      alerts.forEach(function(a) {
        html += '<div class="alert alert-' + a.cor + '"><strong>' + esc(a.tipo) + ':</strong> ' + esc(a.msg) + '</div>';
      });
      html += '</div></div></div>';
    }
  });

  if (html === '') html = '<div class="empty-state"><div class="empty-state-icon">&#9888;</div><div class="empty-state-text">Nenhum alerta critico no momento</div></div>';
  document.getElementById('alertas-list').innerHTML = html;
}

// Init
loadProcessos();
</script>
</body>
</html>`;
}

// === CRON SCHEDULE (local only - Vercel uses serverless, no persistent process) ===
if (!IS_VERCEL) {
  cron.schedule('0 7 * * *', () => {
    console.log('[CRON] DataJud 07:00 iniciada');
    runUpdate('cron-07h');
  });
  cron.schedule('0 19 * * *', () => {
    console.log('[CRON] DataJud 19:00 iniciada');
    runUpdate('cron-19h');
  });
  cron.schedule('0 6 * * *', () => {
    console.log('[CRON] Comunica PJe 06:00 iniciada');
    runComunicaUpdate('cron-06h');
  });
  cron.schedule('0 10 * * *', () => {
    console.log('[CRON] Comunica PJe 10:00 iniciada');
    runComunicaUpdate('cron-10h');
  });
  cron.schedule('0 14 * * *', () => {
    console.log('[CRON] Comunica PJe 14:00 iniciada');
    runComunicaUpdate('cron-14h');
  });
  cron.schedule('0 18 * * *', () => {
    console.log('[CRON] Comunica PJe 18:00 iniciada');
    runComunicaUpdate('cron-18h');
  });
  console.log('[CRON] DataJud: 07h e 19h | Comunica PJe: 06h, 10h, 14h, 18h');
}

// === START SERVER (local only) ===
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`\n=========================================================`);
    console.log(`  BURLINGTON LEGAL - Dashboard + API`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`=========================================================`);
    console.log(`  Endpoints:`);
    console.log(`    GET  /           -> Dashboard`);
    console.log(`    GET  /api/status -> Status dos processos`);
    console.log(`    POST /api/atualizar -> Iniciar atualização`);
    console.log(`    GET  /api/progress -> Progresso da atualização`);
    console.log(`    GET  /api/processos -> Dados completos`);
    console.log(`  Cron: 07:00 e 19:00 diariamente`);
    console.log(`=========================================================\n`);
  });
}

// Export for Vercel serverless
module.exports = app;
