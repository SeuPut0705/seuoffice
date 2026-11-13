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

- `canEdit`가 `false`인 사람은 문서를 보기만 한다. 그 사람이 보낸 편집과 "저장했다" 보고는 서버가 받지 않는다. 그 사람은 에포크를 시작하지 못하고(기준 파일을 보내라는 요청을 받지 않고 에포크가 생길 때까지 기다린다), 그 사람의 문서 지문은 비교하지 않는다.
- `Principal.fileHash`에 호스트가 지금 맞다고 아는 파일의 SHA-256(소문자 16진수)을 넣을 수 있다. 넣으면 정확히 그 파일을 가진 사람만 새 에포크를 시작한다. 다른 파일로 시작하려는 소켓은 `forbidden`을 받는다. 에포크가 이미 있으면 이 값은 쓰이지 않는다.
- 제한은 `createCollabServer({ store, limits })`로 바꾼다. 기본값은 다음과 같다.
  - `maxChangeBytes` 8 MiB: 텍스트 프레임 하나, 곧 변경 하나의 크기. 편집 하나가 이만큼 클 수 있다. 붙여 넣은 그림은 편집기 단계 하나에 담겨 온다. 엔진은 작은 편집을 `SUBMIT_CHUNK_BYTES`(64 KiB)까지 한 변경으로 묶고, 그보다 큰 편집은 혼자 한 변경으로 보낸다. 편집 하나가 `MAX_CHANGE_BYTES`(8 MiB)를 넘으면 보내지 않는다. 그러므로 이 값을 `MAX_CHANGE_BYTES`보다 작게 잡지 않는다. 두 상수는 `@seuoffice/collab/client`에서 가져온다. WebSocket 라이브러리의 프레임 한도(`ws`의 `maxPayload`)도 이 값과 `maxBaseBytes`보다 크게 둔다.
  - `maxBaseBytes` 50 MiB: 기준 파일 하나의 크기.
  - `catchUpPage` 200: 따라잡을 때 저장소에서 한 번에 읽는 변경 수.
  - `idleEpochMs` 10분: 아무도 없는 문서의 저장된 에포크를 끝내기까지 기다리는 시간. `Infinity`면 끝내지 않는다.
  - `seedTimeoutMs` 30초: 기준 파일을 보내라는 요청을 받은 소켓이 보내기까지 기다리는 시간. 넘으면 그 소켓을 닫고 기다리는 다음 편집자에게 묻는다.
  - `maxQueuedFrames` 256: 소켓 하나에서 받아 두고 아직 처리하지 않은 프레임 수. 넘으면 그 소켓을 닫는다. 크기 제한은 프레임을 쌓기 전에 검사한다.
  - `maxQueuedBytes` 32 MiB: 소켓 하나에서 받아 두고 아직 처리하지 않은 프레임들의 크기 합. 넘으면 그 소켓을 닫는다. 소켓의 첫 바이너리 프레임(기준 파일)은 세지 않고 `maxBaseBytes`만 그 크기를 제한한다. 큰 변경 하나는 받을 수 있어야 하므로 이 값을 `maxChangeBytes`보다 작게 잡지 않는다.
- 저장소가 예외를 던지면 그 일을 하던 소켓 하나만 닫힌다. 그 클라이언트는 다시 연결해 이어 받고, 다른 소켓은 그대로다.
- 끌 때는 `await collab.close()`를 부른다. 모든 소켓을 닫고 문서마다 하던 일을 마친다. 에포크는 저장소에 남으므로, 내구성 저장소를 쓰면 서버를 다시 띄운 뒤에도 클라이언트가 이어 받는다.

### 호스트가 꼭 할 일

- **`onSave`에서 더 오래된 버전을 거절한다.** 여러 사람이 저장하면 저장이 끝나는 순서가 버전 순서와 다를 수 있다. 버전 7 파일을 저장한 뒤 늦게 도착한 버전 5 파일로 덮어쓰면, 6과 7의 편집이 저장된 파일에서 소리 없이 사라진다. 서버는 이미 7까지 저장됐다고 알고 있으므로, 그 뒤 에포크가 끝나면 이 손실은 되돌릴 수 없다. 그래서 문서마다 저장한 가장 큰 버전을 기억하고, 그보다 작은 버전이 오면 `throw`한다. 선택 사항이 아니다.
- **공동 편집 밖에서 저장된 파일을 바꿨으면 `await collab.reset(documentId)`를 부른다.** 이전 판으로 되돌리기나 다른 파일로 덮어쓰기가 그렇다. 그 문서의 소켓은 모두 `reset` 오류를 받고 닫히며 에포크는 버려진다. 다음에 여는 사람은 새 파일로 새 에포크를 시작한다. 마지막 저장 뒤의 편집은 버려진다.
- **편집 형식(op 스키마)을 바꿔 배포할 때는 `format.schema`를 올린다.** 다른 스키마의 에포크가 남아 있는 문서를 새 페이지가 열면 `schema_mismatch`를 받는다. 배포 전에 에포크가 끝나기를 기다리거나(모두 저장하고 `idleEpochMs` 동안 아무도 없을 때), 문서마다 `reset`을 부른다. `reset`은 마지막 저장 뒤의 편집을 버리므로, 먼저 저장하게 한 뒤 부른다.

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
- `markSaved`는 지금까지 받은 가장 큰 버전을 남기고 그 값을 돌려준다. 서버는 머리보다 큰 버전을 보내지 않는다.
- `drop`은 이름 붙인 에포크만 지운다. 그 문서에 다른 에포크가 있으면 아무것도 하지 않는다. 지운 뒤의 `create`는 버전 0에서 시작하고, 지운 에포크에서 쓰인 `(client, seq)`도 다시 쓸 수 있다.
- 없거나 지워진 에포크에 대한 `readBase`와 `read`는 reject한다. `append`는 reject하지 않고 `gone`을 돌려준다.
- `ops`는 JSON 값으로 돌려주면 된다. 객체의 키 순서는 바뀌어도 된다(PostgreSQL의 `jsonb`처럼). 문자열과 숫자는 그대로여야 한다. 숫자를 10진수 열로 바꾸는 저장소에서는 `1e21`, `-2.5` 같은 값이 그대로 돌아오는지 확인한다.
- 변경 하나는 `maxChangeBytes`(기본 8 MiB)까지 클 수 있다. 항목 하나의 크기가 더 작은 저장소는 큰 변경을 따로 저장해야 한다. DynamoDB는 항목이 400 KB까지다. 그런 저장소에서는 `ops`를 객체 저장소(S3 같은 곳)에 두고 로그 항목에는 그 위치만 적는다. `read`는 원래의 `ops`를 채워서 돌려준다. 이 경우 `append`의 원자성은 로그 항목을 쓰는 한 번으로 지키고, 객체는 그보다 먼저 쓴다.

### 저장소 시험하기

원자적이지 않은 저장소는 평소에는 잘 돌다가, 두 사람이 같은 순간 편집할 때 같은 버전을 두 번 주고 문서를 소리 없이 어긋나게 한다. 직접 만든 저장소는 `@seuoffice/collab/conformance`의 `storeContract`로 확인한다. `storeContract(makeStore, options)`는 사례 목록을 돌려준다. 사례마다 `run()`이 있고, 계약을 어기면 예외를 던진다. 시험 도구는 무엇이든 쓸 수 있다. vitest라면 다음과 같다.

```ts
import { describe, it } from 'vitest'
import { storeContract } from '@seuoffice/collab/conformance'

describe('our CollabStore', () => {
  const cases = storeContract(() => openStore(testDatabase), {
    reopen: () => openStore(testDatabase), // 같은 데이터를 보는 두 번째 인스턴스
  })
  for (const each of cases) it.skipIf(each.skip !== undefined)(each.name, each.run)
})
```

- 사례마다 새 문서 id를 쓰므로 시험용 데이터베이스 하나를 모든 사례가 함께 써도 된다. `makeStore`가 매번 새 인스턴스를 줘도 되고 같은 인스턴스를 줘도 된다.
- 시험하는 것: `create`의 먼저 온 쪽이 이기는 규칙(동시에 여러 번 불러도), `base === head`일 때만 붙는 `append`, 머리를 담은 `stale`, 원래 버전을 담은 `duplicate`(그 `base`가 이제 맞지 않아도), `gone`, 같은 `base`로 동시에 온 여러 `append` 가운데 하나만 붙는지, `read`의 순서와 빈틈과 `limit`, 수백 KiB짜리 편집이 그대로 돌아오는지, `markSaved`가 뒤로 가지 않는지, `readBase`, `drop` 뒤의 새 에포크, 문서끼리 섞이지 않는지.
- `reopen`을 주면 같은 데이터를 보는 두 번째 인스턴스를 열어 같은 상태가 보이는지, 두 인스턴스에서 동시에 온 `append` 가운데 하나만 붙는지 확인한다. 서버를 여러 대 띄운다면 반드시 준다. 주지 않으면 그 사례는 `skip`에 이유를 담아 건너뛴다.
- 동시 호출 수는 `options.concurrency`(기본 16)로 바꾼다. 동시성 사례는 경합을 확실히 일으키지 못한다. 통과했다고 원자성이 증명되지는 않으므로, 데이터베이스 쪽에서 조건부 쓰기(DynamoDB의 `ConditionExpression`, SQL의 유일 키와 트랜잭션)로 비교와 추가를 한 번에 해야 한다.

## 엔진 붙이기

페이지는 `CollabLink`(웹에서는 `@seuoffice/web-platform`의 `collabLink()`)와 연 파일을 넘겨 참여한다. 편집기는 `join.baseBytes`를 연다. 다른 사람이 먼저 연 문서면 호스트가 준 바이트가 아니라 그 문서의 기준 파일이 온다.

```ts
import { joinCollab } from '@seuoffice/collab/client'

const join = await joinCollab(
  link,
  { format: { name: 'docx', schema: 1 }, bytes },
  { saveTimeoutMs: 30_000 },
)
await editor.open(join.baseBytes)
const session = join.attach(adapter)

session.subscribe((status) => render(status)) // phase, failure, canEdit, version, saved, unconfirmed, peers, self
const { fileName, bytes: saved, version } = await session.save()
await host.store(fileName, saved)
session.reportSaved(version)
```

`status.self`는 이 페이지 자신이다. 서버가 준 클라이언트 id와, 호스트가 이 소켓의 `Principal.name`으로 정한 표시 이름이 들어 있다. `peers` 안의 자기 항목과 같다. 처음 `welcome`을 받기 전에는 `null`이다. 편집기가 변경 추적에 사람 이름을 남길 때 이 이름을 쓴다.

`save()`는 입력을 잠그고, 이 사람의 편집이 모두 서버에서 확정될 때까지 기다린다. 잠글 때 편집기가 마무리한 편집(입력 중이던 셀, 조합 중이던 글자)도 여기에 들어간다. 그다음 다른 사람의 변경을 잠시 붙잡아 둔 채 정확히 한 버전의 파일을 만든다. 파일을 다 만들면 붙잡아 둔 변경을 반영하고 입력을 다시 연다. `saveTimeoutMs`(기본 30초) 안에 편집을 확정하지 못하면 `CollabError('offline')`로 거절하고 입력을 다시 연다. 편집은 그대로 남아 연결이 돌아오면 보내진다. 닫힌 세션의 `save()`는 `CollabError('closed')`로 거절한다.

`exportLocal()`은 지금 화면 그대로의 파일을 준다. 확정되지 않은 편집도 들어 있고 버전은 없다. 서버에 아무것도 알리지 않는다. 연결이 끊겼거나 세션이 실패했을 때도 쓸 수 있으므로, 잃을 뻔한 편집을 사용자가 따로 내려받게 할 때 쓴다. 파일을 만드는 동안 입력을 잠그고 다른 사람의 변경을 붙잡아 둔다.

연결이 끊기면 `phase`가 `offline`이 되고 편집은 계속 쌓인다. 엔진은 0.5초부터 두 배씩, 최대 15초 간격으로 다시 연결해 끊긴 곳부터 이어 받고, 쌓인 편집을 보낸다. 간격은 새 연결에서 변경이 하나라도 오간 뒤에야 0.5초로 돌아간다. 받아 주기만 하고 바로 끊는 서버에 빠르게 다시 붙지 않기 위해서다. 서버가 연결 세 번 연속으로, 그 사이 변경 하나 오가지 못한 채 프로토콜을 어기면 엔진은 다시 연결하지 않고 `reset`으로 실패한다.

어댑터가 한 번에 알린 편집 묶음은 여러 변경으로 나뉘어 들어갈 수 있다. 작은 편집은 64 KiB(`SUBMIT_CHUNK_BYTES`)까지 한 변경으로 묶이고, 그보다 큰 편집은 혼자 한 변경이 된다. 편집 하나가 `MAX_CHANGE_BYTES`(8 MiB)를 넘으면 보내지 않고 세션이 `adapter`로 실패한다. 그 뒤 `save()`가 던지는 `CollabError`의 메시지에 그 편집의 크기가 나온다.

`phase`가 `failed`이면 편집기는 잠기고 다시 열어야 한다. 잠기기 전의 편집은 `exportLocal()`로 꺼낼 수 있다. `failure`는 다음 중 하나다.

| `failure`         | 뜻                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `schema_mismatch` | 문서가 다른 형식이나 다른 스키마 판으로 편집되고 있다                                                                           |
| `reset`           | 에포크가 끝났다(위의 세 경우). 또는 서버가 이 페이지의 프레임을 읽지 못했거나, 연결 세 번 연속으로 프로토콜을 어겼다            |
| `diverged`        | 같은 버전에서 두 사람의 문서 지문이 달랐다. 에포크도 함께 끝난다                                                                |
| `superseded`      | 같은 클라이언트가 새 연결로 다시 들어왔다                                                                                       |
| `forbidden`       | 보기만 하는 사람의 편집기가 편집을 알렸다(엔진은 보내지 않는다). 또는 그런 편집이 서버에 닿았다                                 |
| `adapter`         | 어댑터가 예외를 던졌거나, `integrate` 안이나 파일을 만드는 동안 편집을 알렸거나, 한 변경에 담을 수 없을 만큼 큰 편집을 만들었다 |

## 어댑터가 하는 일

편집기 하나마다 `CollabAdapter<Op>`를 하나 만든다. `Op`는 그 편집기의 편집 단위다.

- `encode`, `decode`: 편집을 JSON으로 바꾸고 되돌린다. `decode`는 모르는 모양을 받으면 예외를 던진다.
- `listen(emit)`: 사람이 한 편집만, 이미 화면에 반영한 뒤 순서대로 알린다. 문서를 열 때와 보기 전용일 때는 아무것도 알리지 않는다. 보기 전용 세션에서 편집을 알리면 세션이 `forbidden`으로 실패한다. `setEditable`이나 `confirmed` 안에서 알린 편집은 보통 편집으로 다룬다(입력 중이던 셀을 잠글 때 마무리하는 경우). `integrate` 안에서나 `produceFile`이 파일을 만드는 동안 알리면 세션이 `adapter`로 실패한다.
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
6. 따라잡기가 끝났을 때 보낸 제출이 이미 무효(다른 사람의 변경이 그 자리를 차지했다)이면, 엔진은 그 제출을 버리고 남은 편집을 같은 `seq`로 새로 보낸다. 그 제출의 `stale` 답이 끊긴 연결로 가 버렸어도 편집이 멈추지 않는다.
7. 엔진은 연결을 열 때마다 시도 번호를 하나씩 올리고, 이어 받는 `hello`에 그 번호(`resume.attempt`)를 싣는다. 서버는 클라이언트 id마다 받아들인 가장 큰 번호를 기억하고, 그보다 작은 번호의 `hello`를 보낸 소켓만 `superseded`로 닫는다. 그래서 이미 버린 연결의 늦은 `hello`가 새 연결을 밀어내지 못한다. 프록시나 여러 서버 프로세스를 거쳐 소켓이 연 순서와 다르게 받아들여져도 같다. 엔진은 열린 연결이 없을 때 오는 프레임(`superseded` 포함)을 버린 소켓의 것으로 보고 무시한다.

6과 7은 프로토콜의 TLA+ 모델(`formal/collab-protocol/`)이 찾은 일정에서 나왔고, 그 일정 그대로를 `tests/scenarios.test.ts`가 재현한다.

서버는 문서마다 한 번에 하나씩 처리한다. 에포크는 위의 세 경우에만 끝난다. 남아 있는 에포크를 여는 사람은 기준 파일과 로그 전체를 받는다.

클라이언트 id는 그 id를 받은 사용자에게 묶인다. 다른 사용자가 그 id로 이어 받으려 하면 서버는 이어 받기를 무시하고 새 id를 준다. 그래서 한 사람이 다른 사람의 페이지를 `superseded`로 밀어낼 수 없다. 이 묶음은 서버 프로세스 메모리에 있다. 서버를 다시 띄운 뒤에는 처음 이어 받는 사람에게 다시 묶인다.

## 라이선스

FSL-1.1-ALv2(소스 공개, 판마다 2년 뒤 Apache-2.0), GenOffice·이음오피스에서 온 부분은 Apache-2.0. 저장소: https://github.com/seuput-inc/seuoffice
