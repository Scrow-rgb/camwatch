# CamWatch

Programa de desktop (janela própria, sem navegador). Instale com `CamWatch-Setup-<versão>.exe`.
Dados ficam em `%APPDATA%\camwatch\data`.

## Atualização automática (repositório privado)
O app confere o GitHub ao abrir e de hora em hora, baixa a versão nova e avisa para reiniciar.
Como o repositório é privado, cada PC precisa de um token **somente leitura**:

1. GitHub > Settings > Developer settings > Fine-grained tokens > Generate new token.
2. Repository access: só `camwatch`. Permissions > Repository > **Contents: Read-only**.
3. Salve o token em `%APPDATA%\camwatch\update-token.txt` (só o texto do token).

## Publicar uma versão nova
1. Aumente `version` no `package.json`.
2. Defina `GH_TOKEN` (token com escrita no repositório) e rode `npm run release`.
