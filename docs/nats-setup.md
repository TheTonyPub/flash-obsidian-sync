# NATS для easy-sync

Нужен NATS с JetStream и доступным плагину адресом `wss://`. Один vault получает один заранее созданный KV bucket и отдельную пару NATS username/password. Пример ниже рассчитан на NATS за Caddy и два vault; замените имена, пароли и домен своими значениями.

## Значения и bucket

| Vault ID в плагине | KV bucket | Stream NATS | NATS username |
| --- | --- | --- | --- |
| `VAULT_A` | `OBS_VAULT_A_FILES` | `KV_OBS_VAULT_A_FILES` | `easy-vault-a` |
| `VAULT_B` | `OBS_VAULT_B_FILES` | `KV_OBS_VAULT_B_FILES` | `easy-vault-b` |

В поле **Vault ID** вводите только `VAULT_A` или `VAULT_B`. Не вводите туда полное имя bucket: плагин сам формирует `OBS_<Vault ID>_FILES` (например, `VAULT_A` → `OBS_VAULT_A_FILES`).

Включите JetStream с постоянным `store_dir`. Администратор NATS создаёт каждый bucket **до** подключения плагина: `nats kv add OBS_VAULT_A_FILES` и `nats kv add OBS_VAULT_B_FILES`, с параметрами **file storage**, **history 10**, **replicas 1**. Проверьте параметры через `nats kv info <bucket>`. У пользователя плагина нет прав на создание bucket. Ключи файлов имеют вид `f.<fileId>`, их subject — `$KV.<bucket>.f.<fileId>`. [NATS KV walkthrough](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/jetstream/key-value-store/kv_walkthrough.md).

Пользователи `easy-vault-a` и `easy-vault-b` из примера ниже не могут создавать bucket. Нужна отдельная административная учётная запись NATS; если её нет, добавьте временного администратора с сильным паролем, создайте bucket и затем удалите эту запись. Для NATS в Docker можно запустить [nats-box](https://github.com/nats-io/nats-box) в сетевом пространстве контейнера `nats`:

```sh
docker run --rm -it --network container:nats natsio/nats-box:latest
```

В открывшейся оболочке nats-box укажите административные учётные данные и создайте bucket. Пароль вводится без отображения в терминале:

```sh
export NATS_URL=nats://127.0.0.1:4222 NATS_USER=bucket-admin
read -s NATS_PASSWORD
export NATS_PASSWORD
nats kv add OBS_VAULT_A_FILES --history 10 --replicas 1 --storage file
nats kv info OBS_VAULT_A_FILES
unset NATS_PASSWORD
```

Для второго vault повторите `nats kv add` и `nats kv info` с `OBS_VAULT_B_FILES`. Убедитесь, что в выводе `kv info` указаны `History Kept: 10` и `Storage: File`.

## Конфигурация сервера

Добавьте блоки к своей конфигурации NATS. Здесь приведены именно права пользователей плагина; администратор использует отдельные учётные данные. Сгенерируйте разные сильные пароли и bcrypt-хеши; в `password` конфигурации укажите **хеш**, а в плагине — **исходный пароль**. NATS принимает bcrypt-хеши в настройке `password`; используйте утилиту `mkpasswd` из проекта NATS. Не публикуйте пароль или конфигурацию с реальными хешами в репозитории. [NATS authentication](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/auth_intro), [NATS server authorization example](https://github.com/nats-io/nats-server/blob/main/server/configs/authorization.conf).

```hcl
jetstream { store_dir: "/path/to/persistent/nats-store" }
websocket {
  listen: "127.0.0.1:9222"
  no_tls: true
}
authorization {
  users: [
    {
      user: "easy-vault-a", password: "<bcrypt-hash-A>"
      permissions: {
        publish: { allow: [
          "$KV.OBS_VAULT_A_FILES.>",
          "$JS.API.STREAM.INFO.KV_OBS_VAULT_A_FILES",
          "$JS.API.DIRECT.GET.KV_OBS_VAULT_A_FILES",
          "$JS.API.STREAM.MSG.GET.KV_OBS_VAULT_A_FILES",
          "$JS.API.CONSUMER.CREATE.KV_OBS_VAULT_A_FILES.>",
          "$JS.API.CONSUMER.INFO.KV_OBS_VAULT_A_FILES.>",
          "$JS.API.CONSUMER.DELETE.KV_OBS_VAULT_A_FILES.>",
          "$JS.API.CONSUMER.MSG.NEXT.KV_OBS_VAULT_A_FILES.>"
        ] }
        subscribe: { allow: ["_INBOX.>", "$KV.OBS_VAULT_A_FILES.>"] }
      }
    },
    {
      user: "easy-vault-b", password: "<bcrypt-hash-B>"
      permissions: {
        publish: { allow: [
          "$KV.OBS_VAULT_B_FILES.>",
          "$JS.API.STREAM.INFO.KV_OBS_VAULT_B_FILES",
          "$JS.API.DIRECT.GET.KV_OBS_VAULT_B_FILES",
          "$JS.API.STREAM.MSG.GET.KV_OBS_VAULT_B_FILES",
          "$JS.API.CONSUMER.CREATE.KV_OBS_VAULT_B_FILES.>",
          "$JS.API.CONSUMER.INFO.KV_OBS_VAULT_B_FILES.>",
          "$JS.API.CONSUMER.DELETE.KV_OBS_VAULT_B_FILES.>",
          "$JS.API.CONSUMER.MSG.NEXT.KV_OBS_VAULT_B_FILES.>"
        ] }
        subscribe: { allow: ["_INBOX.>", "$KV.OBS_VAULT_B_FILES.>"] }
      }
    }
  ]
}
```

Для Caddy добавьте отдельный сайт (или подходящий маршрут в существующем Caddyfile):

```caddyfile
sync.example.com {
  reverse_proxy 127.0.0.1:9222
}
```

Caddy принимает внешний `wss://sync.example.com`, завершает TLS и автоматически проксирует WebSocket upgrade. До NATS идёт обычный `ws://` только через локальный интерфейс. `no_tls: true` допустим в этой схеме лишь при недоступном извне upstream; если Caddy и NATS в разных контейнерах, укажите в `reverse_proxy` внутреннее имя сервиса и порт, а доступ к listener NATS ограничьте приватной сетью. Публичный TCP-порт NATS `4222` для плагина не требуется. Не меняйте путь запроса в Caddy. Сертификат Caddy на `sync.example.com` должен проходить проверку на каждом устройстве. [NATS WebSocket configuration](https://docs.nats.io/reference/config/websocket/), [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [Caddy HTTPS](https://caddyserver.com/docs/automatic-https).

Если Caddy проксирует к NATS через недоверенную сеть, настройте TLS также на WebSocket listener NATS и используйте HTTPS upstream с проверкой сертификата в Caddy. [Caddy HTTPS upstream](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#https).

## Проверка и настройки плагина

В каждом vault откройте настройки **easy-sync** и укажите одинаковый WSS URL Caddy (`wss://sync.example.com`), свой Vault ID и соответствующие NATS username и исходный password. Bucket плагин выбирает как `OBS_<Vault ID>_FILES`. S3 endpoint, bucket, access key и secret key задаются отдельно для передачи бинарных и больших файлов.

Для каждого пользователя проверьте `put/get/watch` в **своём** bucket. Повторите с другим пользователем и другим bucket; запись и чтение чужого bucket должны быть запрещены. Подключение без логина и с неправильным паролем должно отклоняться. Для проверки отзыва удалите пользователя или смените пароль на сервере, перезагрузите конфигурацию NATS и убедитесь, что старый пароль не создаёт новое соединение. Запущенный интеграционный сценарий этих проверок находится в `tests/integration/nats-permissions.test.ts` и использует одноразовый NATS. Он проверяет также `keys`, `create`, `update` и `status` плагина.
