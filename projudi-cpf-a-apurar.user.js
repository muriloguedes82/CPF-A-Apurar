// ==UserScript==
// @name         Projudi - Verificação em Lote de CPF da parte "A Apurar"
// @namespace    cpf-a-apurar.local
// @version      5.1.0
// @description  Para cada processo de uma lista, busca os dados diretamente do Projudi/TJPR por requisição HTTP (sem depender de clicar em nada dentro dos frames do sistema), localiza a parte "A Apurar" e, quando ela não tiver CPF cadastrado, registra o número único, classe processual, assuntos e partes num relatório em PDF, com o CPF em falta destacado em vermelho.
// @author       muriloguedes1982
// @match        *://projudi.tjpr.jus.br/*
// @match        *://*.tjpr.jus.br/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      projudi2.tjpr.jus.br
// @connect      projudi3.tjpr.jus.br
// @connect      projudi4.tjpr.jus.br
// @connect      projudi.tjpr.jus.br
// @connect      tjpr.jus.br
// @require      https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js
// ==/UserScript==

/*
 * COMO USAR
 * ---------
 * 1. Instale este script no Tampermonkey e faça login normalmente no Projudi
 *    (https://projudi.tjpr.jus.br/projudi/).
 * 2. Um painel flutuante "Verificação de CPF - A Apurar" aparece no canto
 *    inferior direito da tela.
 * 3. Cole na caixa de texto os números únicos dos processos (um por linha,
 *    com ou sem pontuação - o script limpa a formatação sozinho).
 * 4. Ajuste, se quiser, a pausa entre processos (padrão 1,5s).
 * 5. Clique em "Iniciar". Na PRIMEIRA vez, o navegador/Tampermonkey deve
 *    perguntar se autoriza este script a acessar projudi2.tjpr.jus.br (ou
 *    similar) - autorize (marque "sempre permitir" para não perguntar de
 *    novo). O script vai, PARA CADA PROCESSO DA LISTA, um de cada vez:
 *       - buscar o processo diretamente por requisição HTTP, usando o
 *         mesmo cookie de sessão do seu login (sem abrir aba nem clicar
 *         em nada na tela);
 *       - pedir a página do processo já com a aba "Partes e Outros";
 *       - procurar a parte "A Apurar" / "A APURAR";
 *       - se ela não tiver CPF/CNPJ cadastrado, guardar os dados do
 *         processo (número único, classe, assunto e a lista de partes)
 *         para entrar no relatório;
 *       - reportar o resultado no painel e seguir para o próximo processo.
 * 6. Quando todos os processos forem processados, clique em "Gerar PDF"
 *    (ou aguarde a geração automática) para baixar um único arquivo PDF
 *    com um relatório de cada ocorrência sem CPF.
 *
 * POR QUE ESSA ABORDAGEM (E NÃO CLICAR NA TELA / TIRAR PRINT)
 * --------------------------------------------------------------
 * Tentamos primeiro automatizar clicando nos elementos da tela, mas o
 * Tampermonkey se mostrou incapaz de injetar um script dentro do frame
 * específico onde o Projudi coloca o formulário de busca
 * (projudi2.tjpr.jus.br) - confirmado pelo log interno do Tampermonkey.
 * Depois tentamos tirar um print (html2canvas) de uma cópia renderizada da
 * página num iframe oculto, mas o conteúdo vinha sempre com tamanho zero
 * (aparentemente por causa da política de CORS bloqueando os recursos de
 * projudi2.tjpr.jus.br dentro de um iframe cuja origem herda da aba
 * principal, projudi.tjpr.jus.br).
 * A solução atual evita os dois problemas: busca os dados diretamente via
 * requisição HTTP (GM_xmlhttpRequest, que reaproveita o cookie de sessão
 * do seu navegador), replicando exatamente as duas requisições que o
 * navegador faz por trás dos panos:
 *   1) POST para processo/buscaProcesso.do?actionType=pesquisaSimples com o
 *      número do processo - isso identifica o ID interno do processo.
 *   2) POST para visualizacaoProcesso.do?actionType=visualizar com esse ID
 *      e selectedIcon=tabPartes - isso já devolve a página do processo com
 *      a aba "Partes e Outros" carregada.
 * O HTML da resposta é interpretado com DOMParser (sem precisar renderizar
 * nada visualmente) para extrair os dados como TEXTO, e o relatório em PDF
 * é desenhado diretamente pelo jsPDF (texto e tabelas), sem depender de
 * nenhuma imagem/print da tela do Projudi.
 * - Se o TJPR atualizar o layout/URLs do sistema, pode ser necessário
 *   ajustar as constantes no bloco "CONFIGURAÇÃO" abaixo.
 * - O domínio usado nas requisições (BASE_HOST) foi identificado como
 *   projudi2.tjpr.jus.br nesta sessão; se no seu caso for outro
 *   (projudi3, projudi4...), ajuste a constante BASE_HOST.
 */

(function () {
  'use strict';

  // ======================= CONFIGURAÇÃO ======================= //
  const BASE_HOST = 'https://projudi2.tjpr.jus.br';
  const SEARCH_URL = BASE_HOST + '/projudi/processo/buscaProcesso.do?actionType=pesquisaSimples';
  const VIEW_URL = BASE_HOST + '/projudi/visualizacaoProcesso.do?actionType=visualizar';

  const SEL_INCLUDE_CONTENT = '#includeContent';
  const SEL_HEADER_TITULO = '#barraTituloStatusProcessual';
  const SEL_RESULT_TABLES = '#includeContent table.resultTable';

  const NOME_ALVO_REGEX = /A\s*APURAR/i;
  const CPF_VAZIO_REGEX = /n[aã]o\s*cadastrado|^$/i;

  const REQUEST_TIMEOUT_MS = 30000;

  // ======================= UTILITÁRIOS ======================= //
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function normalizeProcesso(raw) {
    return String(raw || '').replace(/\D/g, '');
  }

  function parseProcessList(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map(normalizeProcesso)
      .filter(Boolean);
  }

  function formatProcesso(digits) {
    const d = String(digits || '');
    if (d.length !== 20) return d;
    return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16, 20)}`;
  }

  function textoLimpo(el) {
    if (!el) return '';
    // clona e remove <script>/<style> internos antes de ler o texto - o
    // Projudi às vezes coloca um <script> (ex.: inicialização de tooltip)
    // dentro do próprio elemento, e textContent incluiria esse código.
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script, style').forEach((n) => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function extrairNumeroProcesso(doc) {
    const bruto = textoLimpo(doc.querySelector(SEL_HEADER_TITULO));
    const m = bruto.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
    return m ? 'Processo: ' + m[0] : bruto;
  }

  function log(...args) {
    console.log('[CPF-A-Apurar]', ...args);
  }

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest(
        Object.assign(
          {
            timeout: REQUEST_TIMEOUT_MS,
            onload: (res) => resolve(res),
            onerror: (err) => reject(new Error('erro de rede: ' + (err && err.error))),
            ontimeout: () => reject(new Error('tempo esgotado na requisição')),
          },
          opts
        )
      );
    });
  }

  // ======================= BUSCA DO PROCESSO (via HTTP) ======================= //

  function extractProcessoId(html) {
    const m = html.match(/name=["']id["']\s+value=["'](\d+)["']/);
    return m ? m[1] : null;
  }

  async function buscarProcesso(numero) {
    const body =
      'page=1&flagNumeroUnico=true&flagNumeroFisicoAntigo=false&numeroProcesso=' + encodeURIComponent(numero);
    const searchRes = await gmRequest({
      method: 'POST',
      url: SEARCH_URL,
      data: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    });

    const id = extractProcessoId(searchRes.responseText);
    if (!id) {
      throw new Error('não foi possível identificar um único processo para esse número');
    }

    // reproduz os campos ocultos de paginação/ordenação que o formulário
    // real da página envia (valores padrão observados), para reduzir o
    // risco do servidor se comportar de forma diferente por falta deles.
    const viewBody = [
      'id=' + encodeURIComponent(id),
      'selectedIcon=tabPartes',
      'promovidasPageSize=2147483547',
      'promovidasPageNumber=1',
      'promovidasSortColumn=' + encodeURIComponent('parte.nome'),
      'promovidasSortOrder=asc',
      'vitimasPageSize=2147483547',
      'vitimasPageNumber=1',
      'vitimasSortColumn=' + encodeURIComponent('parte.nome'),
      'vitimasSortOrder=asc',
    ].join('&');

    const viewRes = await gmRequest({
      method: 'POST',
      url: VIEW_URL,
      data: viewBody,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    });

    return new DOMParser().parseFromString(viewRes.responseText, 'text/html');
  }

  // ======================= EXTRAÇÃO DOS DADOS ======================= //

  function extrairDadosCompletos(doc) {
    const numeroTexto = extrairNumeroProcesso(doc);
    const classeTexto = textoLimpo(doc.querySelector('.definitionClasseProcessual'));
    const assuntoTexto = textoLimpo(doc.querySelector('.definitionAssuntoPrincipal'));

    const tables = Array.from(doc.querySelectorAll(SEL_RESULT_TABLES));
    const secoes = [];

    for (const table of tables) {
      let h4 = table.previousElementSibling;
      while (h4 && h4.tagName !== 'H4') h4 = h4.previousElementSibling;
      const titulo = h4 ? textoLimpo(h4) : '(seção sem título)';

      const headerCells = Array.from(table.querySelectorAll('thead th'));
      let cpfIdx = headerCells.findIndex((th) => /CPF\s*\/?\s*CNPJ/i.test(th.textContent || ''));
      if (cpfIdx === -1) cpfIdx = 3;

      // só nos interessa a linha da parte "A Apurar" - as demais partes do
      // processo não entram no relatório.
      const linhas = [];
      table.querySelectorAll('tbody tr').forEach((row) => {
        const nameCell = row.children[1];
        const nome = textoLimpo(nameCell);
        if (!nome || !NOME_ALVO_REGEX.test(nome)) return;
        const rg = textoLimpo(row.children[2]);
        const cpf = textoLimpo(row.children[cpfIdx]);
        linhas.push({ nome, rg, cpf, destacar: CPF_VAZIO_REGEX.test(cpf) });
      });

      if (linhas.length) secoes.push({ titulo, linhas });
    }

    return { numeroTexto, classeTexto, assuntoTexto, secoes };
  }

  async function extractFromDoc(doc) {
    const tables = Array.from(doc.querySelectorAll(SEL_RESULT_TABLES));
    let foundRow = null;
    let foundTable = null;

    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr');
      for (const row of rows) {
        const nameCell = row.children[1];
        if (!nameCell) continue;
        const text = textoLimpo(nameCell);
        if (NOME_ALVO_REGEX.test(text)) {
          foundRow = row;
          foundTable = table;
          break;
        }
      }
      if (foundRow) break;
    }

    if (!foundRow) {
      return { status: 'NAO_ENCONTRADO' };
    }

    const headerCells = Array.from(foundTable.querySelectorAll('thead th'));
    let cpfIdx = headerCells.findIndex((th) => /CPF\s*\/?\s*CNPJ/i.test(th.textContent || ''));
    if (cpfIdx === -1) cpfIdx = 3;

    const cpfText = textoLimpo(foundRow.children[cpfIdx]);
    const semCpf = CPF_VAZIO_REGEX.test(cpfText);

    if (!semCpf) {
      return { status: 'OK_TEM_CPF', cpfText };
    }

    return { status: 'ALERTA_SEM_CPF', dados: extrairDadosCompletos(doc) };
  }

  async function processarUm(numero) {
    try {
      const doc = await buscarProcesso(numero);
      return await extractFromDoc(doc);
    } catch (e) {
      log('erro processando', numero, e);
      return { status: 'ERRO', mensagem: String((e && e.message) || e) };
    }
  }

  // ======================= PAINEL DE CONTROLE ======================= //

  function initControllerUI() {
    if (document.getElementById('cpfrun-panel')) return;

    // Projudi serve uma página antiga baseada em <frameset>. Nesse caso,
    // document.body (por spec) aponta para o próprio elemento <frameset>,
    // e elementos "extras" anexados dentro dele normalmente NÃO são
    // renderizados pelo navegador. Por isso, quando body for um frameset,
    // montamos o painel direto em document.documentElement (a tag <html>).
    let mountPoint = document.body;
    if (!mountPoint || mountPoint.tagName === 'FRAMESET') {
      mountPoint = document.documentElement;
    }
    if (!mountPoint) {
      setTimeout(initControllerUI, 500);
      return;
    }

    const style = document.createElement('style');
    style.textContent = `
      #cpfrun-panel { position: fixed; right: 16px; bottom: 16px; width: 340px; max-height: 80vh;
        background: #ffffff; border: 1px solid #999; border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,.3);
        z-index: 999999; font: 12px/1.4 Arial, sans-serif; color: #222; display: flex; flex-direction: column; }
      #cpfrun-panel header { background: #1d3d6b; color: #fff; padding: 8px 10px; border-radius: 8px 8px 0 0;
        display: flex; justify-content: space-between; align-items: center; cursor: move; }
      #cpfrun-panel header b { font-size: 13px; }
      #cpfrun-panel .body { padding: 10px; overflow-y: auto; }
      #cpfrun-panel textarea { width: 100%; box-sizing: border-box; height: 90px; font: 11px monospace; }
      #cpfrun-panel .row { display: flex; gap: 8px; margin-top: 6px; align-items: center; }
      #cpfrun-panel .row label { flex: 1; }
      #cpfrun-panel .row input[type=number] { width: 60px; }
      #cpfrun-panel button { cursor: pointer; border: 0; border-radius: 4px; padding: 6px 10px; font-weight: bold; }
      #cpfrun-panel .btn-start { background: #1d7a3d; color: #fff; }
      #cpfrun-panel .btn-pdf { background: #b35900; color: #fff; }
      #cpfrun-panel .btn-stop { background: #a01313; color: #fff; }
      #cpfrun-panel ul#cpfrun-status { list-style: none; margin: 8px 0 0; padding: 0; max-height: 220px; overflow-y: auto; border-top: 1px solid #ddd; }
      #cpfrun-panel ul#cpfrun-status li { padding: 3px 0; border-bottom: 1px dotted #eee; }
      #cpfrun-panel .tag { display:inline-block; padding:1px 5px; border-radius:3px; color:#fff; font-size:10px; margin-left:4px;}
      .tag-pendente{background:#888} .tag-andamento{background:#2a6fc9} .tag-ok{background:#1d7a3d}
      .tag-alerta{background:#c0392b} .tag-naoenc{background:#8e7b1f} .tag-erro{background:#7a1d1d}
      #cpfrun-panel .minbtn{background:transparent;color:#fff;font-size:14px;padding:0 4px;}
    `;
    (document.head || document.documentElement).appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'cpfrun-panel';
    panel.innerHTML = `
      <header>
        <b>Verificação de CPF - A Apurar</b>
        <button class="minbtn" id="cpfrun-toggle" title="Minimizar/Expandir">_</button>
      </header>
      <div class="body" id="cpfrun-body">
        <div>Números do processo (um por linha):</div>
        <textarea id="cpfrun-lista" placeholder="0001421-79.2014.8.16.0077"></textarea>
        <div class="row"><label>Pausa entre processos (s)</label><input type="number" id="cpfrun-pausa" value="1.5" min="0" max="30" step="0.5"></div>
        <div class="row">
          <button class="btn-start" id="cpfrun-start">Iniciar</button>
          <button class="btn-stop" id="cpfrun-stop">Parar</button>
          <button class="btn-pdf" id="cpfrun-pdf" disabled>Gerar PDF</button>
        </div>
        <div id="cpfrun-resumo" style="margin-top:6px;font-weight:bold;"></div>
        <ul id="cpfrun-status"></ul>
      </div>
    `;
    mountPoint.appendChild(panel);
    log('painel de controle montado.');

    // arrastar o painel
    (function makeDraggable() {
      const header = panel.querySelector('header');
      let dragging = false, offX = 0, offY = 0;
      header.addEventListener('mousedown', (e) => {
        if (e.target.id === 'cpfrun-toggle') return;
        dragging = true;
        offX = e.clientX - panel.getBoundingClientRect().left;
        offY = e.clientY - panel.getBoundingClientRect().top;
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = e.clientX - offX + 'px';
        panel.style.top = e.clientY - offY + 'px';
      });
      document.addEventListener('mouseup', () => (dragging = false));
    })();

    document.getElementById('cpfrun-toggle').addEventListener('click', () => {
      const body = document.getElementById('cpfrun-body');
      body.style.display = body.style.display === 'none' ? '' : 'none';
    });

    let state = null;

    document.getElementById('cpfrun-start').addEventListener('click', () => {
      if (state && state.running) return;
      const list = parseProcessList(document.getElementById('cpfrun-lista').value);
      if (!list.length) {
        alert('Cole ao menos um número de processo.');
        return;
      }
      const pausaMs = Math.max(0, (parseFloat(document.getElementById('cpfrun-pausa').value) || 1.5) * 1000);
      state = startSequence(list, pausaMs);
    });

    document.getElementById('cpfrun-stop').addEventListener('click', () => {
      if (state) state.stop();
    });

    document.getElementById('cpfrun-pdf').addEventListener('click', () => {
      if (!state) return;
      buildPdf(state.results);
    });

    function renderStatus(list) {
      const ul = document.getElementById('cpfrun-status');
      ul.innerHTML = '';
      let ok = 0, alerta = 0, naoenc = 0, erro = 0, pend = 0;
      list.forEach((item) => {
        const li = document.createElement('li');
        let tagClass = 'tag-pendente', tagText = 'pendente';
        switch (item.status) {
          case 'ANDAMENTO': tagClass = 'tag-andamento'; tagText = 'em andamento'; break;
          case 'OK_TEM_CPF': tagClass = 'tag-ok'; tagText = 'possui CPF'; ok++; break;
          case 'ALERTA_SEM_CPF': tagClass = 'tag-alerta'; tagText = 'SEM CPF'; alerta++; break;
          case 'NAO_ENCONTRADO': tagClass = 'tag-naoenc'; tagText = 'sem "A Apurar"'; naoenc++; break;
          case 'ERRO': tagClass = 'tag-erro'; tagText = 'erro: ' + (item.mensagem || '?'); erro++; break;
          default: pend++;
        }
        li.innerHTML = `${item.processo || '(?)'} <span class="tag ${tagClass}">${tagText}</span>`;
        ul.appendChild(li);
      });
      document.getElementById('cpfrun-resumo').textContent =
        `Total: ${list.length} | Sem CPF: ${alerta} | OK: ${ok} | Sem parte: ${naoenc} | Erro: ${erro} | Pendentes: ${pend}`;
      document.getElementById('cpfrun-pdf').disabled = alerta === 0;
    }

    function startSequence(list, pausaMs) {
      const results = list.map((p) => ({ processo: p, status: 'PENDENTE' }));
      renderStatus(results);

      let stopped = false;
      let allDone = false;

      (async () => {
        for (let i = 0; i < list.length; i++) {
          if (stopped) break;
          results[i].status = 'ANDAMENTO';
          renderStatus(results);

          const r = await processarUm(list[i]);
          results[i] = Object.assign(results[i], r);
          renderStatus(results);

          if (stopped) break;
          if (i < list.length - 1) await sleep(pausaMs);
        }
        allDone = true;
        log('sequência concluída.');
      })();

      return {
        results,
        get running() {
          return !stopped && !allDone;
        },
        stop() {
          stopped = true;
        },
      };
    }

    // ======================= GERAÇÃO DO PDF ======================= //

    function buildPdf(results) {
      const flagged = results.filter((r) => r && r.status === 'ALERTA_SEM_CPF' && r.dados);
      if (!flagged.length) {
        alert('Nenhum processo com a parte "A Apurar" sem CPF foi encontrado.');
        return;
      }

      const jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
      if (!jsPDFCtor) {
        alert('Biblioteca jsPDF não carregou. Recarregue a página e tente novamente.');
        return;
      }

      const doc = new jsPDFCtor({ unit: 'mm', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 12;
      const usableW = pageW - margin * 2;
      const bottomLimit = pageH - margin;

      const colNome = usableW * 0.42;
      const colRg = usableW * 0.24;
      const colCpf = usableW * 0.34;

      let y = margin;
      let primeiroDaPagina = true;

      function garantirEspaco(alturaNecessaria) {
        if (!primeiroDaPagina && y + alturaNecessaria > bottomLimit) {
          doc.addPage();
          y = margin;
          primeiroDaPagina = true;
        }
      }

      function linhaSeparadora() {
        doc.setDrawColor(200);
        doc.setLineWidth(0.2);
        doc.line(margin, y, margin + usableW, y);
        y += 4;
      }

      flagged.forEach((item, idx) => {
        const dados = item.dados;

        garantirEspaco(24);
        if (!primeiroDaPagina) {
          linhaSeparadora();
        }
        primeiroDaPagina = false;

        doc.setFont(undefined, 'bold');
        doc.setFontSize(11);
        doc.text(dados.numeroTexto || ('Processo: ' + formatProcesso(item.processo)), margin, y);
        y += 5.5;

        doc.setFont(undefined, 'normal');
        doc.setFontSize(9);
        if (dados.classeTexto) {
          doc.text('Classe Processual: ' + dados.classeTexto, margin, y);
          y += 4.5;
        }
        if (dados.assuntoTexto) {
          doc.text('Assunto Principal: ' + dados.assuntoTexto, margin, y);
          y += 4.5;
        }
        y += 1.5;

        dados.secoes.forEach((secao) => {
          garantirEspaco(12);
          doc.setFont(undefined, 'bold');
          doc.setFontSize(9.5);
          doc.text(secao.titulo, margin, y);
          y += 4.5;

          doc.setFontSize(8);
          doc.text('Nome', margin, y);
          doc.text('RG', margin + colNome, y);
          doc.text('CPF/CNPJ', margin + colNome + colRg, y);
          y += 3;
          doc.setDrawColor(180);
          doc.setLineWidth(0.15);
          doc.line(margin, y, margin + usableW, y);
          y += 3.5;

          doc.setFont(undefined, 'normal');
          secao.linhas.forEach((linha) => {
            const nomeLinhas = doc.splitTextToSize(linha.nome || '-', colNome - 2);
            const alturaLinha = Math.max(4, nomeLinhas.length * 3.6);
            garantirEspaco(alturaLinha + 2);

            doc.text(nomeLinhas, margin, y);
            doc.text(linha.rg || '-', margin + colNome, y);
            const cpfX = margin + colNome + colRg;
            doc.text(linha.cpf || '-', cpfX, y);

            if (linha.destacar) {
              doc.setDrawColor(220, 0, 0);
              doc.setLineWidth(0.5);
              doc.rect(cpfX - 1.5, y - 3.3, colCpf - 1, alturaLinha);
              doc.setDrawColor(0);
              doc.setLineWidth(0.15);
            }

            y += alturaLinha + 1;
          });
          y += 2;
        });

        y += 2;
      });

      doc.save('processos_A_Apurar_sem_CPF_' + new Date().toISOString().slice(0, 10) + '.pdf');
    }
  }

  // ======================= INICIALIZAÇÃO ======================= //

  if (window.top === window) {
    log('script carregado em', location.href);
    try {
      initControllerUI();
    } catch (e) {
      log('ERRO ao montar o painel de controle:', e);
    }
  }
})();
