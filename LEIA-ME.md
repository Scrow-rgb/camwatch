# CamWatch

Programa de desktop (janela própria, sem navegador). Instale com `CamWatch-Setup-<versão>.exe`.
Dados ficam em `%APPDATA%mwatchdata`.

## Atualização automática
O app confere o GitHub ao abrir e de hora em hora, baixa a versão nova sozinho e avisa para reiniciar. Não precisa de token.

## Publicar uma versão nova
1. Aumente `version` no `package.json`.
2. Defina `GH_TOKEN` (token com escrita no repositório) e rode `npm run release`.
