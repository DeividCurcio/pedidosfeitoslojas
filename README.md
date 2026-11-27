# Controle de Pedidos — API própria

O aplicativo continua sendo uma página HTML única, servida pela API no mesmo domínio. A API usa Node.js e SQLite para contas de e-mail/senha, equipes e pedidos compartilhados; atualizações de equipe chegam aos navegadores por Server-Sent Events.

## Rodar neste computador

1. Instale Node.js 22 ou mais recente.
2. Na pasta do projeto, rode `npm install`.
3. Rode `npm start`.
4. Abra `http://localhost:3000` — não abra o HTML diretamente como `file://`.

O banco é criado em `data/pedidos.sqlite`. Essa pasta é ignorada pelo Git e contém os dados das contas e pedidos; faça backup protegido antes de migrar ou trocar de máquina.

## Contas e equipes

- Crie uma conta com nome, e-mail e senha de pelo menos 10 caracteres.
- A primeira pessoa cria a equipe e compartilha o código de convite de 6 caracteres.
- As demais criam suas próprias contas e entram com o código.
- Ao criar ou entrar em uma equipe, os lançamentos locais deste aparelho podem ser importados. A importação é idempotente e os registros locais não são apagados.
- `file://` e `http://localhost` têm armazenamentos separados no navegador. Se os registros estiverem no HTML aberto diretamente, use **Exportar registros locais** antes de mudar para o servidor; depois, qualquer membro da equipe pode importar o backup JSON.
- Os pedidos feitos na equipe são compartilhados, mostram quem lançou e atualizam a lista e a presença de pessoas online em tempo real.

As senhas são armazenadas como hashes `scrypt`; o navegador recebe um cookie de sessão `HttpOnly`. A API limita tentativas de login/cadastro/convite por endereço IP. Esta versão não envia e-mails de confirmação nem recuperação de senha.

## Publicar na Render

O arquivo `render.yaml` define um serviço Node na região da Virgínia, uma verificação de saúde e um disco persistente de 1 GB para o SQLite. Para publicar:

1. Abra o [painel da Render](https://dashboard.render.com/) e escolha **New → Blueprint**.
2. Conecte `DeividCurcio/pedidosfeitoslojas` e selecione a branch `main`.
3. Revise o serviço e o preço no painel antes de confirmar a criação.
4. Após o deploy, abra a URL `onrender.com` informada pela Render. Essa URL é o app completo; o GitHub Pages não executa a API Node nem persiste o SQLite.

O plano configurado é `0.5c-512mb` (US$ 7/mês) mais disco de 1 GB (US$ 0,25/GB/mês), conforme a tabela de preços consultada em novembro de 2026. Podem existir cobranças adicionais de tráfego ou impostos; confirme o valor vigente no painel antes de provisionar.

O serviço lê `RENDER_EXTERNAL_URL` para validar a origem HTTPS. `DATA_DIR=/var/data` aponta para o disco; `TRUST_PROXY=1` confia nos cabeçalhos do proxy da Render para rate limiting. O SQLite com disco persistente exige uma única instância; não habilite escala horizontal. Configure backups e nunca envie `.env` ou `data/` ao Git.

Para outro host, configure `NODE_ENV=production`, `APP_ORIGIN` com a origem HTTPS exata, `PORT` conforme o provedor, `DATA_DIR` em um volume persistente e `TRUST_PROXY=1` somente atrás de um proxy confiável.
