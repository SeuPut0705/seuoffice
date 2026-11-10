# @seuoffice/collab

호스트 웹앱에 넣은 seuoffice 문서를 여러 사람이 동시에 고치게 해 주는 중앙 도구. 서버 하나가 모든 편집의 순서를 정하고, 각 편집기는 작은 어댑터 하나로 같은 클라이언트 엔진에 붙는다. 엔진과 서버는 편집 내용(`ops`)을 읽지 않는다. 그래서 문서 형식과 상관없이 같은 코드가 다섯 편집기를 모두 맡는다.

세 진입점이 있다. 프레임 형식(와이어 타입)은 어느 진입점으로도 내보내지 않는다.

- `@seuoffice/collab/server`: Node 22에서 도는 서버, 저장소 포트 `CollabStore`, `memoryStore()`.
- `@seuoffice/collab/client`: 브라우저에서 도는 엔진 `joinCollab`과 어댑터 계약.
- `@seuoffice/collab/conformance`: 어댑터가 계약을 지키는지 확인하는 시뮬레이터와 장난감 어댑터 두 개.

런타임 의존성은 없다. 해시는 `crypto.subtle`로 계산한다.

## 서버 띄우기

호스트가 WebSocket 업그레이드 요청을 직접 인증하고, 그 소켓이 어느 문서의 누구인지(`Principal`)를 정해 `accept`에 넘긴다. 페이지는 문서 이름을 보내지 않는다. 아래는 `ws` 소켓을 `ServerSocket`에 맞추는 예다.

```ts
import { WebSocketServer, type WebSocket } from 'ws'
import { createCollabServer, memoryStore, type ServerSocket } from '@seuoffice/collab/server'

const collab = createCollabServer({ store: memoryStore() })
const wss = new WebSocketServer({ noServer: true })

const serverSocket = (ws: WebSocket): ServerSocket => ({
  send: (frame) => ws.readyState === ws.OPEN && ws.send(frame),
  close: (code, reason) => ws.close(code, reason),
  onMessage: (handler) =>
    ws.on('message', (data, binary) => handler(binary ? (data as Buffer) : String(data))),
  onClose: (handler) => ws.on('close', handler),
})

httpServer.on('upgrade', async (request, socket, head) => {
  const principal = await authenticate(request) // { documentId, userId, name, canEdit } 또는 null
  if (!principal) return socket.destroy()
  wss.handleUpgrade(request, socket, head, (ws) => collab.accept(serverSocket(ws), principal))
})
```

- `canEdit`가 `false`인 사람은 문서를 보기만 한다. 그 사람이 보낸 편집과 "저장했다" 보고는 서버가 받지 않는다.
- 제한은 `createCollabServer({ store, limits })`로 바꾼다. 기본값은 텍스트 프레임 하나 `maxChangeBytes` 256 KiB, 기본 파일 `maxBaseBytes` 50 MiB, 따라잡기 한 번에 읽는 변경 수 `catchUpPage` 200, 아무도 없는 문서의 에포크를 끝내기까지 기다리는 시간 `idleEpochMs` 10분이다. 엔진은 편집을 64 KiB씩 나눠 보내므로 `maxChangeBytes`를 그보다 작게 잡지 않는다. `idleEpochMs`를 `Infinity`로 주면 에포크를 끝내지 않는다.
- 공동 편집 밖에서 저장된 파일을 바꿨으면(이전 판으로 되돌리기, 다른 파일로 덮어쓰기) `await collab.reset(documentId)`를 부른다. 그 문서의 소켓은 모두 `reset` 오류를 받고 닫히며 에포크는 버려진다. 다음에 여는 사람은 새 파일로 새 에포크를 시작한다.
- 끌 때는 `await collab.close()`를 부른다. 모든 소켓을 닫고 문서마다 하던 일을 마친다. 에포크는 저장소에 남으므로, 내구성 저장소를 쓰면 서버를 다시 띄운 뒤에도 클라이언트가 이어 받는다.

### 에포크가 끝나는 때

에포크는 다음 세 경우에만 끝난다. 마지막 소켓이 떠났다고 바로 끝나지는 않는다.

1. 문서에 소켓이 `idleEpochMs` 동안 하나도 없었고, 저장된 버전이 머리와 같다. 기다리는 시간은 마지막 소켓이 떠날 때 시작하고, 그 사이 소켓이 하나라도 들어오면 처음부터 다시 잰다. 저장하지 않은 변경이 있으면 아무리 오래 기다려도 끝나지 않는다.
2. 호스트가 `reset(documentId)`을 불렀다.
3. 같은 버전에서 두 사람의 지문이 달랐다(`diverged`). 서버는 그 에포크의 소켓을 모두 닫고, 저장 여부와 상관없이 에포크를 버린다. 다음에 여는 사람은 호스트가 저장해 둔 파일로 새 에포크를 시작한다. 그래서 마지막으로 저장한 뒤의 편집은 잃는다. 어긋난 상태에서는 어느 쪽 파일이 맞는지 알 수 없으므로, 틀린 파일을 저장하지 않으려고 일부러 그렇게 한다.

그래서 혼자 고치던 사람이 저장한 뒤 연결이 끊긴 채 계속 고치다가 다시 연결해도 편집을 잃지 않는다. 그 사이에 동료가 문서를 열었어도 같다. 동료는 같은 에포크의 기준 파일과 로그를 받는다.

### 저장소는 호스트가 만든다

이 패키지에는 `memoryStore()`만 들어 있다. 프로세스 메모리에 두므로 서버가 다시 뜨면 모두 사라진다. 서버를 다시 띄워도 편집이 남아야 하면 호스트가 자기 데이터베이스로 `CollabStore`를 구현한다. 지킬 것은 다음과 같다.

- 모든 메서드는 문서 하나에 대해 원자적이다.
- `append`는 비교 후 추가 한 번이다. 같은 `(client, seq)`가 이미 있으면 그때의 버전으로 `duplicate`를 돌려준다. 이 검사가 `base` 검사보다 먼저다. `base`가 지금 머리(head)와 같을 때만 `head + 1`로 붙이고, 아니면 `stale`과 지금 머리를 돌려준다. 그 에포크가 없으면 `gone`이다.
- 버전은 1부터 빈틈없이 늘고 다시 쓰지 않는다.
- `markSaved`는 지금까지 받은 가장 큰 버전을 남기고 그 값을 돌려준다.

## 엔진 붙이기

페이지는 `CollabLink`(웹에서는 `@seuoffice/web-platform`의 `collabLink()`)와 연 파일을 넘겨 참여한다. 편집기는 `join.baseBytes`를 연다. 다른 사람이 먼저 연 문서면 호스트가 준 바이트가 아니라 그 문서의 기준 파일이 온다.

```ts
import { joinCollab } from '@seuoffice/collab/client'

const join = await joinCollab(link, { format: { name: 'docx', schema: 1 }, bytes })
await editor.open(join.baseBytes)
const session = join.attach(adapter)

session.subscribe((status) => render(status)) // phase, failure, canEdit, version, saved, unconfirmed, peers
const { fileName, bytes: saved, version } = await session.save()
await host.store(fileName, saved)
session.reportSaved(version)
```

`save()`는 입력을 잠그고, 이 사람의 편집이 모두 서버에서 확정될 때까지 기다린다. 그다음 다른 사람의 변경을 잠시 붙잡아 둔 채 정확히 한 버전의 파일을 만든다. 파일을 다 만들면 붙잡아 둔 변경을 반영하고 입력을 다시 연다.

연결이 끊기면 `phase`가 `offline`이 되고 편집은 계속 쌓인다. 엔진은 0.5초부터 두 배씩, 최대 15초 간격으로 다시 연결해 끊긴 곳부터 이어 받고, 쌓인 편집을 보낸다. 서버가 연결 세 번 연속으로, 그 사이 변경 하나 오가지 못한 채 프로토콜을 어기면 엔진은 다시 연결하지 않고 `reset`으로 실패한다.

`phase`가 `failed`이면 편집기는 잠기고 다시 열어야 한다. `failure`는 다음 중 하나다.

| `failure`         | 뜻                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `schema_mismatch` | 문서가 다른 형식이나 다른 스키마 판으로 편집되고 있다                                                                |
| `reset`           | 에포크가 끝났다(위의 세 경우). 또는 서버가 이 페이지의 프레임을 읽지 못했거나, 연결 세 번 연속으로 프로토콜을 어겼다 |
| `diverged`        | 같은 버전에서 두 사람의 문서 지문이 달랐다. 에포크도 함께 끝난다                                                     |
| `superseded`      | 같은 클라이언트가 새 연결로 다시 들어왔다                                                                            |
| `forbidden`       | 보기만 하는 사람이 편집을 보냈다                                                                                     |
| `adapter`         | 어댑터가 예외를 던졌거나, `integrate` 안에서 편집을 알렸거나, 보낼 수 없을 만큼 큰 편집을 만들었다                   |

## 어댑터가 하는 일

편집기 하나마다 `CollabAdapter<Op>`를 하나 만든다. `Op`는 그 편집기의 편집 단위다.

- `encode`, `decode`: 편집을 JSON으로 바꾸고 되돌린다. `decode`는 모르는 모양을 받으면 예외를 던진다.
- `listen(emit)`: 사용자가 한 편집을 이미 화면에 반영한 뒤 순서대로 알린다.
- `integrate(remote, local)`: 화면은 확정된 상태 위에 이 사람의 미확정 편집 `local`이 얹힌 모습이다. 서버 순서로 확정된 `remote`를 반영하고, `remote` 뒤에 적용되도록 고친 `local`을 돌려준다. 동기 함수이고 그 안에서 `emit`을 부르지 않는다. 위치가 서로 바뀌는 편집은 위치 대신 대상의 정체성으로 가리키면 다시 쓰기가 쉽다.
- `confirmed(ops)`: 이 사람의 편집이 확정됐다. 확정본을 따로 두는 어댑터만 쓴다.
- `fingerprint()`: 문서 상태의 해시. 같은 버전에서 미확정 편집이 없으면 모든 사람에게 같아야 한다. 부른 순간의 상태를 읽어야 한다. 해시 계산만 나중에 끝나도 된다.
- `setEditable(editable)`: 입력을 잠그거나 연다.
- `produceFile()`: 지금 화면 그대로의 파일 바이트. 편집기에 아무 영향도 주지 않는다.

`@seuoffice/collab/conformance`의 `simulate`로 어댑터를 시험한다. 실제 서버와 `memoryStore()` 위에서 여러 엔진을 시드로 정해진 무작위 순서로 돌린다. 연결이 끊기고, 늦은 프레임이 오고, 저장과 늦은 참여자가 섞인다. 끝나면 모든 사람의 지문이 같은지, 보낸 편집이 로그에 정확히 한 번씩 있는지, 늦은 참여자가 같은 상태에 이르는지, 저장한 파일을 다시 열면 그 버전의 상태인지 확인한다. 실패하면 메시지에 시드가 나온다.

```ts
import { simulate } from '@seuoffice/collab/conformance'

await simulate({
  seed,
  clients: 3,
  steps: 400,
  file: { format, bytes },
  adapterFactory: (bytes) => openHeadless(bytes),
})
```

`adapterFactory`가 돌려주는 어댑터에는 무작위 편집을 하나 만드는 `edit(random, id)`와, 편집 JSON에서 그 `id`를 읽는 `opKey(op)`가 더 있어야 한다. `toyMap`(키마다 나중 값이 이기는 표)과 `toyLines`(줄 목록, 위치로 넣고 지우며 `integrate`에서 실제로 위치를 고친다)가 그 예다.

## 지켜지는 것

문서마다 에포크가 하나 있다. 에포크는 기준 파일과 빈틈없는 변경 로그로 이루어진다. 버전 V의 상태는 기준 파일을 열고 변경 1..V를 순서대로 적용한 결과다.

1. 변경은 제출의 `base`가 머리와 같을 때만 붙고, `head + 1`이 된다.
2. 한 로그에서 `(client, seq)`는 한 번만 나온다.
3. 버전은 빈틈없고, 한 에포크 안에서 다시 쓰이지 않는다.
4. 소켓마다 시작 버전 다음의 모든 변경을 정확히 한 번, 순서대로 받는다. 자기 변경은 보낸 소켓에서 `ack`로 받는다.
5. 클라이언트는 보낸 제출이 결코 붙을 수 없다는 증거(다른 사람의 변경이 `base + 1`을 차지했거나, 그 제출에 `stale` 답이 왔다)가 있을 때만 그 제출의 편집을 고친다.

서버는 문서마다 한 번에 하나씩 처리한다. 에포크는 위의 세 경우에만 끝난다. 남아 있는 에포크를 여는 사람은 기준 파일과 로그 전체를 받는다.

클라이언트 id는 그 id를 받은 사용자에게 묶인다. 다른 사용자가 그 id로 이어 받으려 하면 서버는 이어 받기를 무시하고 새 id를 준다. 그래서 한 사람이 다른 사람의 페이지를 `superseded`로 밀어낼 수 없다. 이 묶음은 서버 프로세스 메모리에 있다. 서버를 다시 띄운 뒤에는 처음 이어 받는 사람에게 다시 묶인다.

## 라이선스

Apache-2.0. 저장소: https://github.com/SeuPut0705/seuoffice
