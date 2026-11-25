# Установка «Моих квот» агентом

Цель: подключить **v0.1.0** к уже настроенному CLIProxyAPI пользователя в OpenCode Desktop. Сборка входит в тег. Не нужен доступ к GitHub-аккаунту, биллингу администратора или хранилищу ключей.

1. Проверь `opencode --version` (целевая версия — 2.3.2). Определи **ID и HTTPS origin существующего CPA-провайдера**. Учитывай провайдера текущей модели; локальное имя у разных пользователей может отличаться. Для обнаружения можно выполнить следующую команду. Она выводит только ID и origin подходящих подключений; не выводи сырой результат `provider.list`, весь конфиг, заголовки или секреты.

   ```sh
   opencode api provider.list | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{for(const p of JSON.parse(s).data){if(p.activation==="disabled" || p.package!=="@opencode/ai/providers/openai-compatible") continue;try{const u=new URL(p.settings?.baseURL);if(u.protocol==="https:" && !u.username && !u.password && !u.search && !u.hash)console.log(p.id,u.origin)}catch{}}})'
   ```

   OpenAI-совместимый провайдер не обязательно является CLIProxyAPI. Подтверди наличие каталога: сделай **GET без ключа и без редиректов** к `/.well-known/cpa-quota-policy.json` на выбранном origin и проверь `schemaVersion: 1` и массив `pools`. Если однозначного подключения нет, спроси у пользователя только ID провайдера. Не подставляй адрес из этого руководства.

2. Узнай каталог глобального конфига через `opencode debug paths config`. В активном `opencode.json` или `opencode.jsonc` добавь в `plugins` **одну объектную запись**, как в примере ниже, заменив оба демонстрационных значения результатами шага 1. Редактируй существующий JSON/JSONC точечно, сохраняя комментарии, плагины и другие настройки. Если запись этой версии или предыдущая установка плагина уже есть, обнови её вместо дублирования. При отсутствии конфига создай его с `$schema` и `plugins`.

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [{
       "package": "github:eskorpado/cliproxy-personal-quota#v0.1.0",
       "options": { "providerID": "my-cpa", "origin": "https://cpa.example.org" }
     }]
   }
   ```

   `origin` — протокол, хост и нестандартный порт, если он есть, **без** `/v1`, query и fragment. Ключ остаётся в текущих настройках провайдера или в активном подключении OpenCode. Не переноси его в `options`. OpenCode сам установит пакет GitHub по этой записи и перечитает конфиг.

3. Проверь `opencode plugin list`: `cliproxy-personal-quota` должен быть активен. Вызови RPC на встроенном локальном сервере: `opencode api post /api/rpc/cliproxy-personal-quota/snapshot -d '{"input":{"revalidate":true}}'`. Проверь в `output` поля `asOf`, `issue` и `pools`; в ответе пользователю достаточно статуса. При `provider` перепроверь ID и origin, при `key` или `unauthorized` — что выбрано активное подключение, при `catalog-*` — публичный каталог. Пустой `pools` со свежим `asOf` и без ошибки означает, что запрос прошёл, но доступных пулов нет. Не включай деморежим для маскировки ошибки.

4. Сообщи результат и предложи открыть **`/quotas`** (или **«Мои квоты»** в меню **+** боковой панели). Для удаления достаточно убрать добавленную запись `plugins`.
