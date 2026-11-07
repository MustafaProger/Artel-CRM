#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
if ! command -v npm >/dev/null 2>&1; then
  print 'Для запуска нужен Node.js. Установите его и запустите файл повторно.'
  read '?Нажмите Enter, чтобы закрыть окно.'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  npm ci
fi
print 'Артэль CRM: http://127.0.0.1:5173'
print 'Оставьте это окно открытым. Для остановки нажмите Ctrl+C.'
npm run dev
