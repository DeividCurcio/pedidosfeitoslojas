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

## Colocar online

GitHub Pages não executa esta API. Publique o projeto completo em um host que execute Node.js (ou em um servidor próprio) e mantenha **uma instância** da API com disco persistente para o SQLite. Configure:

- `NODE_ENV=production`
- `APP_ORIGIN=https://seu-dominio`
- `PORT` conforme informado pelo host
- `DATA_DIR` apontando para um volume persistente e privado
- `TRUST_PROXY=1` somente se o host for um proxy confiável que define `X-Forwarded-For`

Use HTTPS, proteja o acesso ao volume de dados e mantenha backups. Não publique `data/`, `.env` ou cópias do banco. A tela de login só fica disponível quando a página é servida pela própria API.
