# CPF-A-Apurar

Script para Tampermonkey que automatiza, no Projudi/TJPR
(`https://projudi.tjpr.jus.br/projudi/`), a verificação em lote de processos
em busca da parte cadastrada como **"A Apurar"** (ou "A APURAR") sem CPF
vinculado.

Arquivo: [`projudi-cpf-a-apurar.user.js`](./projudi-cpf-a-apurar.user.js)

## O que o script faz

1. Você cola a lista de números únicos de processo em um painel flutuante
   que aparece no canto da tela após o login.
2. O script abre várias abas em segundo plano (padrão: 20 simultâneas,
   ajustável) e, em cada uma, preenche o número do processo, pesquisa e
   clica na aba **"Partes e Outros"**.
3. Em cada processo, procura a parte **"A Apurar"**. Se ela **não** tiver
   CPF/CNPJ cadastrado, o script:
   - destaca em vermelho a célula do CPF na linha da parte "A Apurar";
   - gera um print contendo o número único, a classe processual, os
     assuntos e a lista de partes;
   - fecha a aba automaticamente.
4. Ao final, o botão **"Gerar PDF"** junta todos os prints das ocorrências
   sem CPF em um único arquivo PDF, com várias imagens por página
   (configurável) para reduzir o tamanho do arquivo.

## Instalação

1. Instale a extensão [Tampermonkey](https://www.tampermonkey.net/) no
   navegador.
2. Abra o painel do Tampermonkey → "Criar novo script" e cole o conteúdo de
   `projudi-cpf-a-apurar.user.js` (ou instale diretamente a partir do
   arquivo bruto do repositório, se o Tampermonkey oferecer essa opção).
3. Salve. O script passa a valer para qualquer página em
   `*.tjpr.jus.br/projudi/*`.

## Uso

Veja o cabeçalho de comentários no topo do arquivo `projudi-cpf-a-apurar.user.js`
("COMO USAR") para o passo a passo detalhado e observações importantes sobre
os seletores usados e uso responsável (evitar sobrecarregar o servidor do
TJPR com muitas abas simultâneas).

## Observação

Este script depende da estrutura HTML atual das páginas do Projudi
(IDs como `#numeroProcesso`, `#pesquisar`, `#tabItemprefix2`,
`#includeContent`, `table.resultTable`, etc.). Caso o TJPR altere o layout
do sistema, pode ser necessário ajustar as constantes no bloco
"CONFIGURAÇÃO" do script.
