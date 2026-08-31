// ==UserScript==
// @name         Projudi - Verificação em Lote de CPF da parte "A Apurar"
// @namespace    cpf-a-apurar.local
// @version      3.2.0
// @description  Percorre vários processos do Projudi/TJPR, um de cada vez, na mesma aba: entra na aba "Partes e Outros", localiza a parte "A Apurar" e, quando ela não tiver CPF cadastrado, gera um print (número único, classe, assuntos e partes) com a coluna do CPF destacada em vermelho. Ao final, junta tudo em um único PDF.
// @author       muriloguedes1982
// @match        *://*.tjpr.jus.br/*
// @match        *://projudi.tjpr.jus.br/*
// @match        *://projudi2.tjpr.jus.br/*
// @match        *://projudi3.tjpr.jus.br/*
// @match        *://projudi4.tjpr.jus.br/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
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
 * 4. Ajuste, se quiser, a pausa entre processos (padrão 1,5s) e quantas
 *    imagens por página no PDF final (padrão 2).
 * 5. Clique em "Iniciar". O script vai, PARA CADA PROCESSO DA LISTA, UM DE
 *    CADA VEZ, na própria aba em que você está (sem abrir abas novas):
 *       - localizar o campo de busca, digitar o número e pesquisar;
 *       - clicar na aba "Partes e Outros";
 *       - procurar a parte "A Apurar" / "A APURAR";
 *       - se ela não tiver CPF/CNPJ cadastrado, tirar um print da área com
 *         o número único, classe processual, assuntos e partes, destacando
 *         em vermelho a célula do CPF da parte "A Apurar";
 *       - reportar o resultado ao painel de controle e seguir para o
 *         próximo processo da lista.
 * 6. Quando todos os processos forem processados, clique em "Gerar PDF"
 *    (ou aguarde a geração automática) para baixar um único arquivo PDF
 *    com todos os prints das ocorrências sem CPF.
 *
 * OBSERVAÇÕES IMPORTANTES
 * ------------------------
 * - Este script depende de IDs/seletores específicos das páginas do Projudi
 *   (#processoBusca, #numeroProcesso, #pesquisar, #tabItemprefix2,
 *   #includeContent, table.resultTable, #barraTituloStatusProcessual,
 *   #informacoesProcessuais). Se o TJPR atualizar o layout do sistema, pode
 *   ser necessário ajustar as constantes no topo do bloco "CONFIGURAÇÃO"
 *   abaixo.
 * - O Projudi é montado com frames/iframes aninhados (topo em
 *   projudi.tjpr.jus.br > frame "área de atuação" em projudi2.tjpr.jus.br
 *   > iframe "userMainFrame" com a "mesa" e o formulário de busca, mesma
 *   origem do frame pai). Este script roda em TODAS as janelas/frames da
 *   página e usa o armazenamento do Tampermonkey (GM_setValue/
 *   GM_addValueChangeListener) para a janela de topo avisar qual processo
 *   deve ser pesquisado agora e para quem encontrar o resultado avisar de
 *   volta - isso funciona instantaneamente em qualquer frame, não importa
 *   a origem/subdomínio ou quando ele carregar. Além disso, sempre que
 *   consegue rodar em algum frame, o script também tenta agir diretamente
 *   em qualquer <iframe>/<frame> filho de MESMA ORIGEM (via
 *   contentDocument) - isso cobre o caso em que o Tampermonkey não
 *   conseguiu (ou demorou a) injetar um script separado num frame filho
 *   específico.
 * - Processamento é SEQUENCIAL (um processo por vez, na mesma aba) para não
 *   sobrecarregar/derrubar a sessão no servidor do TJPR como acontecia ao
 *   abrir várias abas simultâneas.
 * - O TJPR exibe o Projudi dentro de um portal (barra "PDPJ-Br"/
 *   "cabecalho-oid.jsp"), então a aba de verdade (topo da janela) pode não
 *   estar em uma URL que contenha "/projudi/" - por isso o @match cobre
 *   todo o domínio *.tjpr.jus.br. Além disso, essa página de topo costuma
 *   ser um <frameset> antigo, então o painel é montado em
 *   document.documentElement (não em document.body).
 */

(function () {
  'use strict';

  // ======================= CONFIGURAÇÃO ======================= //
  const SEL_MENU_BUSCA = '#processoBusca';
  const SEL_NUM_PROCESSO = '#numeroProcesso';
  const SEL_BTN_PESQUISAR = '#pesquisar';
  const SEL_TAB_PARTES = '#tabItemprefix2 a';
  const SEL_INCLUDE_CONTENT = '#includeContent';
  const SEL_HEADER_TITULO = '#barraTituloStatusProcessual';
  const SEL_HEADER_INFO_TABLE = '#informacoesProcessuais';
  const SEL_RESULT_TABLES = '#includeContent table.resultTable';

  const NOME_ALVO_REGEX = /A\s*APURAR/i;
  const CPF_VAZIO_REGEX = /n[aã]o\s*cadastrado|^$/i;

  const TASK_TIMEOUT_MS = 90000; // tempo máximo por processo antes de desistir e ir para o próximo
  const POLL_INTERVAL_MS = 500; // intervalo de checagem do estado da página em cada frame

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

  function log(...args) {
    console.log('[CPF-A-Apurar]', ...args);
  }

  // ======================= PARTE "TRABALHADOR" (roda em toda janela/frame) ======================= //
  // A janela de topo mantém a fila de processos e, a cada momento, grava
  // (via GM_setValue) qual é o processo "da vez". Como o armazenamento do
  // Tampermonkey NÃO é isolado por frame/origem (ao contrário de
  // postMessage, que depende de alcançar o frame certo na árvore, algo que
  // se mostrou frágil no Projudi - o formulário de busca mora num frame que
  // demora a carregar, tipo usuario/mesaAnalista.do), TODOS os frames da
  // aba enxergam o mesmo valor instantaneamente via
  // GM_addValueChangeListener, não importa em qual frame/origem estejam.
  // Cada frame verifica o que existe no DOM e avança sozinho (clicar no
  // menu de busca, preencher e pesquisar, clicar em "Partes e Outros",
  // extrair o resultado) e reporta o resultado de volta do mesmo jeito.

  const GM_KEY_TASK = 'cpfrun_task';
  const GM_KEY_RESULT = 'cpfrun_result';

  let currentTask = null; // { processo, seq }

  function adoptTask(t) {
    if (!t || !t.seq) return;
    if (!currentTask || currentTask.seq !== t.seq) {
      currentTask = t;
      log('tarefa recebida:', t.processo, '(seq', t.seq + ') | URL desta página:', location.href);
      log(
        'diagnóstico desta página ->',
        'processoBusca:', !!document.querySelector(SEL_MENU_BUSCA),
        '| numeroProcesso:', !!document.querySelector(SEL_NUM_PROCESSO),
        '| pesquisar:', !!document.querySelector(SEL_BTN_PESQUISAR),
        '| abaPartes:', !!document.querySelector(SEL_TAB_PARTES),
        '| includeContent:', !!document.querySelector(SEL_INCLUDE_CONTENT)
      );
    }
  }

  // pega a tarefa atual assim que este frame carrega (caso já exista uma
  // tarefa em andamento quando este documento apareceu) ...
  try {
    const existing = GM_getValue(GM_KEY_TASK, null);
    if (existing) adoptTask(JSON.parse(existing));
  } catch (e) {
    /* ignore */
  }
  // ... e continua ouvindo por novas tarefas a qualquer momento.
  GM_addValueChangeListener(GM_KEY_TASK, (name, oldV, newV) => {
    try {
      adoptTask(JSON.parse(newV));
    } catch (e) {
      /* ignore */
    }
  });

  function reportResult(task, extra) {
    const payload = Object.assign({ processo: task.processo, seq: task.seq }, extra);
    GM_setValue(GM_KEY_RESULT, JSON.stringify(payload));
  }

  // Estado de progresso é rastreado POR DOCUMENTO (não globalmente), porque
  // um único script instanciado num frame pode alcançar e mexer em vários
  // documentos de mesma origem (o seu próprio + filhos same-origin, veja
  // tryAdvanceRecursive). Cada documento tem seu próprio "quanto já avancei".
  const docState = new WeakMap();
  function getDocState(doc) {
    let st = docState.get(doc);
    if (!st) {
      st = { acted: false, actedForSeq: null, lastReportedSeq: null, lastLoggedSignature: null };
      docState.set(doc, st);
    }
    return st;
  }

  function currentPageProcesso(doc) {
    const el = doc.querySelector(SEL_HEADER_TITULO);
    if (!el) return null;
    const digits = (el.textContent || '').replace(/\D/g, '');
    return digits || null;
  }

  async function buildScreenshot(doc) {
    const opts = { backgroundColor: '#ffffff', useCORS: true, allowTaint: true, scale: 1.3, logging: false };
    const canvases = [];
    const headerTitulo = doc.querySelector(SEL_HEADER_TITULO);
    const headerInfo = doc.querySelector(SEL_HEADER_INFO_TABLE);
    const partes = doc.querySelector(SEL_INCLUDE_CONTENT);

    if (headerTitulo) canvases.push(await html2canvas(headerTitulo, opts));
    if (headerInfo) canvases.push(await html2canvas(headerInfo, opts));
    if (partes) canvases.push(await html2canvas(partes, opts));

    if (!canvases.length) return null;

    const width = Math.max(...canvases.map((c) => c.width));
    const gap = 10;
    const totalHeight = canvases.reduce((s, c) => s + c.height + gap, 0);

    const combined = document.createElement('canvas');
    combined.width = width;
    combined.height = totalHeight;
    const ctx = combined.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, totalHeight);

    let y = 0;
    for (const c of canvases) {
      ctx.drawImage(c, 0, y);
      y += c.height + gap;
    }
    return combined.toDataURL('image/jpeg', 0.82);
  }

  async function extractAndReport(doc, task) {
    const tables = Array.from(doc.querySelectorAll(SEL_RESULT_TABLES));
    let foundRow = null;
    let foundTable = null;

    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr');
      for (const row of rows) {
        const nameCell = row.children[1];
        if (!nameCell) continue;
        const text = (nameCell.textContent || '').replace(/\s+/g, ' ').trim();
        if (NOME_ALVO_REGEX.test(text)) {
          foundRow = row;
          foundTable = table;
          break;
        }
      }
      if (foundRow) break;
    }

    if (!foundRow) {
      reportResult(task, { status: 'NAO_ENCONTRADO' });
      return;
    }

    const headerCells = Array.from(foundTable.querySelectorAll('thead th'));
    let cpfIdx = headerCells.findIndex((th) => /CPF\s*\/?\s*CNPJ/i.test(th.textContent || ''));
    if (cpfIdx === -1) cpfIdx = 3;

    const cpfCell = foundRow.children[cpfIdx];
    const cpfText = ((cpfCell && cpfCell.textContent) || '').replace(/\s+/g, ' ').trim();
    const semCpf = CPF_VAZIO_REGEX.test(cpfText);

    if (!semCpf) {
      reportResult(task, { status: 'OK_TEM_CPF', cpfText });
      return;
    }

    const prevStyle = cpfCell.getAttribute('style') || '';
    cpfCell.style.boxShadow = 'inset 0 0 0 4px #ff0000, 0 0 0 2px #ff0000';
    cpfCell.style.backgroundColor = 'rgba(255,0,0,0.15)';
    await sleep(80);

    let imageDataUrl = null;
    try {
      imageDataUrl = await buildScreenshot(doc);
    } catch (e) {
      log('erro ao gerar screenshot', e);
    }

    cpfCell.setAttribute('style', prevStyle);

    if (!imageDataUrl) {
      reportResult(task, { status: 'ERRO_SCREENSHOT' });
      return;
    }

    reportResult(task, { status: 'ALERTA_SEM_CPF', imageDataUrl });
  }

  async function tryAdvanceOn(doc) {
    if (!currentTask) return;
    const st = getDocState(doc);
    if (st.lastReportedSeq === currentTask.seq) return; // já tratamos esta tarefa neste documento

    // uma tarefa nova chegou neste mesmo documento (não navegou) - libera a
    // trava de "já cliquei" para poder agir de novo.
    if (st.acted && st.actedForSeq !== currentTask.seq) {
      st.acted = false;
    }

    const pageProcesso = currentPageProcesso(doc);
    const processoCorreto = pageProcesso === currentTask.processo;

    const includeContent = doc.querySelector(SEL_INCLUDE_CONTENT);
    const partesCarregadas = includeContent && includeContent.querySelector('table.resultTable');

    // log de diagnóstico toda vez que o "retrato" deste documento muda,
    // para acompanhar a navegação sem inundar o console a cada 500ms.
    const signature = [
      doc.URL,
      !!doc.querySelector(SEL_MENU_BUSCA),
      !!doc.querySelector(SEL_NUM_PROCESSO),
      pageProcesso,
      !!doc.querySelector(SEL_TAB_PARTES),
      !!partesCarregadas,
    ].join('|');
    if (signature !== st.lastLoggedSignature) {
      st.lastLoggedSignature = signature;
      log('estado da página mudou ->', signature);
    }

    if (partesCarregadas && processoCorreto) {
      st.lastReportedSeq = currentTask.seq;
      log('partes carregadas para', currentTask.processo, '- extraindo...');
      await extractAndReport(doc, currentTask);
      return;
    }

    // Já clicamos em algo para esta tarefa e ainda não vimos o resultado -
    // não clica de novo, só espera (evita cliques repetidos a cada 500ms
    // enquanto a navegação/carregamento da página ainda está em curso,
    // que pode levar vários segundos no Projudi).
    if (st.acted) return;

    const tabLink = doc.querySelector(SEL_TAB_PARTES);
    if (tabLink && processoCorreto) {
      st.acted = true;
      st.actedForSeq = currentTask.seq;
      log('clicando em "Partes e Outros" para', currentTask.processo, '| doc:', doc.URL);
      tabLink.click();
      return;
    }

    // se a página mostra um processo diferente do atual (sobra da consulta
    // anterior) ou nenhum processo, não tenta extrair nem clicar na aba de
    // partes - precisa primeiro voltar para a busca.
    const numField = doc.querySelector(SEL_NUM_PROCESSO);
    const btnPesquisar = doc.querySelector(SEL_BTN_PESQUISAR);
    if (numField && btnPesquisar) {
      st.acted = true;
      st.actedForSeq = currentTask.seq;
      log('preenchendo busca com', currentTask.processo, '| doc:', doc.URL);
      numField.value = currentTask.processo;
      numField.dispatchEvent(new Event('input', { bubbles: true }));
      numField.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(150);
      btnPesquisar.click();
      return;
    }

    const buscaMenu = doc.querySelector(SEL_MENU_BUSCA);
    if (buscaMenu && !processoCorreto) {
      st.acted = true;
      st.actedForSeq = currentTask.seq;
      log('clicando no menu de busca de processo | doc:', doc.URL);
      buscaMenu.click();
      return;
    }
  }

  // Tenta agir no documento deste frame E, recursivamente, em qualquer
  // <iframe>/<frame> filho que seja da MESMA ORIGEM (contentDocument
  // acessível sem erro de cross-origin) - assim, um único frame em que o
  // Tampermonkey conseguiu injetar o script consegue alcançar e operar
  // frames filhos de mesma origem mesmo que o Tampermonkey não tenha
  // (ou ainda não tenha) injetado um script separado ali dentro. Frames
  // filhos de origem DIFERENTE precisam ter o próprio script injetado
  // neles (o que também acontece na maioria das vezes) para se cuidarem
  // sozinhos.
  async function tryAdvanceRecursive(doc) {
    try {
      await tryAdvanceOn(doc);
    } catch (e) {
      log('erro no avanço de estado', e);
    }
    let frames;
    try {
      frames = doc.querySelectorAll('iframe, frame');
    } catch (e) {
      return;
    }
    for (const f of frames) {
      let childDoc = null;
      try {
        childDoc = f.contentDocument;
      } catch (e) {
        childDoc = null;
      }
      if (childDoc) {
        await tryAdvanceRecursive(childDoc);
      }
    }
  }

  function startWorker() {
    setInterval(() => {
      tryAdvanceRecursive(document);
    }, POLL_INTERVAL_MS);
  }

  // ======================= PARTE "CONTROLADOR" (painel na aba principal) ======================= //

  function initControllerUI() {
    if (document.getElementById('cpfrun-panel')) return;

    // Projudi serve uma página antiga baseada em <frameset>. Nesse caso,
    // document.body (por spec) aponta para o próprio elemento <frameset>,
    // e elementos "extras" anexados dentro dele normalmente NÃO são
    // renderizados pelo navegador (o frameset só sabe desenhar frame/
    // frameset/noframes). Por isso, quando body for um frameset, montamos
    // o painel direto em document.documentElement (a tag <html>), que
    // renderiza normalmente um elemento com position:fixed por cima de tudo.
    let mountPoint = document.body;
    if (!mountPoint || mountPoint.tagName === 'FRAMESET') {
      mountPoint = document.documentElement;
    }
    if (!mountPoint) {
      log('painel: DOM ainda não está pronto, tentando novamente em 500ms...');
      setTimeout(initControllerUI, 500);
      return;
    }

    log('painel: montando painel de controle em', mountPoint.tagName);

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
        <div class="row"><label>Imagens por página no PDF</label><input type="number" id="cpfrun-perpage" value="2" min="1" max="6"></div>
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
    log('painel: painel de controle adicionado com sucesso.');

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
      const perPage = Math.max(1, parseInt(document.getElementById('cpfrun-perpage').value, 10) || 2);
      buildPdf(state.results, perPage);
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
          case 'TIMEOUT': tagClass = 'tag-erro'; tagText = 'tempo esgotado'; erro++; break;
          case 'ERRO_SCREENSHOT': tagClass = 'tag-erro'; tagText = 'erro no print'; erro++; break;
          default: pend++;
        }
        li.innerHTML = `${item.processo || '(?)'} <span class="tag ${tagClass}">${tagText}</span>`;
        ul.appendChild(li);
      });
      document.getElementById('cpfrun-resumo').textContent =
        `Total: ${list.length} | Sem CPF: ${alerta} | OK: ${ok} | Sem parte: ${naoenc} | Erro/timeout: ${erro} | Pendentes: ${pend}`;
      document.getElementById('cpfrun-pdf').disabled = alerta === 0;
    }

    function startSequence(list, pausaMs) {
      const results = list.map((p) => ({ processo: p, status: 'PENDENTE' }));
      renderStatus(results);

      const runId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      let index = 0;
      let n = 0;
      let stopped = false;
      let allDone = false;
      let timeoutHandle = null;
      let currentAssignedTask = null;

      const resultListenerId = GM_addValueChangeListener(GM_KEY_RESULT, (name, oldV, newV) => {
        try {
          const d = JSON.parse(newV);
          if (!currentAssignedTask || d.seq !== currentAssignedTask.seq) return; // resultado de tarefa antiga, ignora
          finishCurrent(d);
        } catch (e) {
          log('erro ao interpretar resultado', e);
        }
      });

      function launchNext() {
        if (stopped) return;
        if (index >= list.length) {
          finishAll();
          return;
        }

        const processo = list[index];
        results[index].status = 'ANDAMENTO';
        renderStatus(results);

        n++;
        const task = { processo, seq: runId + ':' + n };
        currentAssignedTask = task;

        GM_setValue(GM_KEY_TASK, JSON.stringify(task));
        log('tarefa', task.processo, '(seq', task.seq + ') publicada.');

        timeoutHandle = setTimeout(() => {
          finishCurrent({ status: 'TIMEOUT', seq: task.seq });
        }, TASK_TIMEOUT_MS);
      }

      function finishCurrent(resultData) {
        if (stopped) return;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }

        results[index] = Object.assign(results[index], resultData);
        renderStatus(results);

        index++;
        currentAssignedTask = null;

        setTimeout(launchNext, pausaMs);
      }

      function finishAll() {
        allDone = true;
        GM_removeValueChangeListener(resultListenerId);
        log('sequência concluída.');
      }

      launchNext();

      return {
        results,
        get running() {
          return !stopped && !allDone;
        },
        stop() {
          stopped = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          GM_removeValueChangeListener(resultListenerId);
        },
      };
    }

    async function buildPdf(results, imagesPerPage) {
      const flagged = results.filter((r) => r && r.status === 'ALERTA_SEM_CPF' && r.imageDataUrl);
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
      const margin = 8;
      const usableW = pageW - margin * 2;
      const usableH = pageH - margin * 2;
      const cellH = usableH / imagesPerPage;

      let onPage = 0;
      for (let i = 0; i < flagged.length; i++) {
        if (i > 0 && onPage === 0) doc.addPage();
        const item = flagged[i];

        const img = await loadImage(item.imageDataUrl);
        const availH = cellH - 8;
        const ratio = Math.min(usableW / img.width, availH / img.height);
        const w = img.width * ratio;
        const h = img.height * ratio;
        const x = margin + (usableW - w) / 2;
        const topOfCell = margin + onPage * cellH;

        doc.setFontSize(9);
        doc.text('Processo: ' + formatProcesso(item.processo), margin, topOfCell + 3);
        doc.addImage(item.imageDataUrl, 'JPEG', x, topOfCell + 6, w, h);

        onPage = (onPage + 1) % imagesPerPage;
      }

      doc.save('processos_A_Apurar_sem_CPF_' + new Date().toISOString().slice(0, 10) + '.pdf');
    }

    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
    }

    function formatProcesso(digits) {
      const d = String(digits || '');
      if (d.length !== 20) return d;
      return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16, 20)}`;
    }
  }

  // ======================= INICIALIZAÇÃO ======================= //

  log('script carregado em', location.href, '| topo?', window.top === window);

  if (window.top === window) {
    try {
      initControllerUI();
    } catch (e) {
      log('ERRO ao montar o painel de controle:', e);
    }
  }

  // toda janela/frame (inclusive os internos do Projudi) fica escutando e,
  // assim que souber qual processo deve tratar, tenta avançar sozinha.
  startWorker();
})();
