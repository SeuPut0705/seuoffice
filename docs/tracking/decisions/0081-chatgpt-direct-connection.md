# 0081 — ChatGPT는 앱이 직접 로그인해 요금제로 연결하고, Codex 프로그램은 그 안의 다른 길로 남긴다

## 맥락

ChatGPT 요금제로 AI를 쓰려면 지금까지 사용자가 Codex 프로그램을 설치하고 로그인해야 했다. 설치와 업데이트는 연결 도움을 요청하는 신고의 큰 몫이었다. 낮은 버전, WSL 사본과의 혼동, 숨긴 로그인 창이 모두 프로그램을 거치는 구조에서 나왔다. 보안 쪽에도 남는 것이 있었다. Codex 자신의 셸 도구는 끌 수 없어 읽기 전용으로 가두고(`docs/security.md`), `~/.codex/AGENTS.md`는 여전히 대화에 들어간다.

OpenAI는 2026-09-29에 "Sign in with ChatGPT"를 열었다. 사용자가 허락하면 다른 앱이 그 사람의 ChatGPT 요금제로 공개 API(`/v1/responses`)를 부른다. 오픈소스이면서 사용자 PC에서 도는 앱은 신청 없이 쓸 수 있고, 유료 앱이나 원격 서비스만 따로 신청한다(https://developers.openai.com/siwc/token-sharing-open-source). 앱은 OpenAI에 "에이전트"로 등록되고 자기 이름의 토큰을 받는다. Codex 프로그램의 로그인을 빌리는 것이 아니다.

결정 0032(2026-10-15)는 이 길을 "앱이 로그인 토큰을 다뤄야 해서 규칙 1번과 맞지 않는다"며 쓰지 않기로 했다. 저장소 주인이 2026-10-28에 이 판단을 다시 하고, 직접 연결을 넣기로 정했다.

Claude는 같은 길이 없다. Anthropic은 별도 허가 없이 다른 앱이 Claude 계정 로그인을 제공하거나 Free·Pro·Max 자격으로 요청을 보내는 것을 금지한다(https://code.claude.com/docs/en/legal-and-compliance). Claude는 지금처럼 사용자가 설치한 Claude Code를 실행한다.

## 결정

**새 제공자 `chatgpt`.** 구독 제공자의 세 번째 식별자다(`AiSubscriptionProviderId`). 화면 이름은 "ChatGPT"다. 프로그램이 없으므로 설치·업데이트·로그인 창·종량 로그인이 없고, 상태는 `signed-out`, `ready`, `error`, `checking` 넷만 나온다. CLI에만 있는 일은 `AiSubscriptionCliId`(`claude-code`, `codex`)로 좁혔다.

**로그인.** OpenAI가 오픈소스 앱에 정한 그대로다.

- 시스템 브라우저에 OpenAI의 로그인 화면을 연다. 앱 안에 로그인 양식은 없다.
- 돌아오는 곳은 `127.0.0.1`의 빈 포트에 연 임시 서버의 `/callback` 하나다. `state`가 맞는 요청 하나에만 답하고, 10분이 지나거나 취소되면 닫는다.
- PKCE(S256), `state`, `nonce`를 시도마다 새로 만든다. 첫 등록은 `client_id=dynamic_agent_client`, 이 설치를 가리키는 `ext_agent_host_id`(한 번 만들어 계속 쓴다), `agent_name_hint`(제품 이름)를 보낸다. 돌아올 때 OpenAI가 발급한 `client_id`를 함께 받는다.
- 범위는 `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, 대상은 `https://api.openai.com/v1`이다. 요금제 사용(`chatgpt.tokens.use.direct`)을 허락하지 않은 로그인은 저장하지 않고 실패로 알린다.
- ID 토큰은 OpenAI가 공개한 키(JWKS)로 서명을 확인하고, 발급자·대상(`client_id`)·만료·`nonce`를 본다.

**토큰 보관.** 데이터 폴더의 `chatgpt-connection.json` 하나다. 접근·갱신·ID 토큰은 설정 파일의 키와 같은 봉인을 거친다(결정 0063: Windows와 키링이 있는 Linux는 운영체제 암호화, macOS는 평문). 파일은 임시 이름으로 다 쓴 뒤 바꾸고, 소유자만 읽게 만든다. 이메일은 쓰지 않는다. 계정의 고정 식별자(`subject`)와 발급된 `client_id`, `ext_agent_host_id`만 평문이다. 화면의 계정 표시는 그 실행 중에 확인한 ID 토큰에서 읽어 메모리에만 둔다.

**갱신과 끊기.** 접근 토큰이 1분 안에 만료되면 요청 전에 갱신한다. 갱신은 한 번에 하나다(갱신 토큰이 바뀌어 같은 것을 두 번 보내면 무효가 된다). 갱신이 `invalid_grant` 같은 답이면 세션을 버리고 `signed-out`이 된다. 네트워크 실패면 아직 유효한 토큰을 쓴다. 연결 끊기는 OpenAI의 폐기 주소(OIDC 설정의 `revocation_endpoint`, `auth.openai.com`일 때만)에 갱신 토큰을 보내고, 폐기가 실패해도 PC의 토큰은 지운다. 이 연결을 끊어도 PC의 다른 프로그램(Codex 포함)은 그대로다.

**요청.** `POST https://api.openai.com/v1/responses`에 `model`, `input`, `store: false`, `stream: true`만 보낸다. OpenAI의 문서가 요금제 사용에서 도구 호출과 구조화 응답을 약속하지 않으므로, Claude 연결부와 같은 규약을 쓴다. 앱의 도구 목록과 응답 스키마를 입력 글에 적고, 모델의 JSON 답 하나를 `parseClaudeCodeTurn`으로 읽는다. 그림은 `input_image`로 보낸다. 요금제가 받지 않는 입력은 OpenAI가 이름을 대어 거절하고, 앱은 그 이름을 오류에 싣는다. ChatGPT의 비공개 주소(`backend-api`)는 쓰지 않는다. 모델은 `GET /v1/models`의 목록에서 고르고, 고르지 않았으면 목록의 첫 모델이다.

**오류.** 요금제 한도(`subscription_sharing_usage_limit_exceeded`)는 `rate-limit`, 앱 연결이 끊긴 것(401, `subscription_sharing_invalid_user`)은 세션을 버리고 `signed-out`이다. 어느 쪽도 다른 제공자로 넘어가지 않는다. `ready`인 다른 구독이 있으면 지금처럼 "〈이름〉(으)로 계속" 버튼이 나온다.

**제공자 선택.** `auto`의 순서는 Claude → ChatGPT → Codex다. ChatGPT와 Codex는 같은 요금제를 쓰고, 직접 연결은 프로그램을 띄우지 않고 셸 도구도 없다. 상태가 있는데 아직 `checking`이면 지금처럼 기다린다. 상태가 아예 없으면(예전 앱, CLI 둘만 적은 호출자) `signed-out`으로 읽는다(`subscriptionStateOf`). 같은 서비스가 세 상태를 늘 함께 만들기 때문에 없는 것은 "그 연결이 없는 곳"이다.

**화면.** 고르는 것은 "어떤 AI"까지다.

- 연결 도우미의 질문은 지금처럼 답이 셋이다(Claude / ChatGPT / 아직 없음). ChatGPT 답은 직접 연결로 펼쳐지고, 단계는 `로그인 → 연결 완료` 둘이다. 버튼은 OpenAI 지침대로 "ChatGPT로 계속"이다.
- Codex는 그 길 안의 링크("이 PC에서 Codex 프로그램을 이미 쓰고 있나요? Codex로 연결")로 연다. Codex 길에는 반대쪽 링크("Codex 없이 앱에서 바로 연결")가 있다. 이미 연결된 길에는 링크가 없다. Codex가 이미 연결돼 있으면 도우미는 Codex 길을 연다.
- 설정 → AI에는 Claude, ChatGPT, Codex 카드가 차례로 있다. ChatGPT 카드는 연결되면 "이 앱에서 쓰는 AI는 ChatGPT 요금제 안에서 처리됩니다"와 "사용량 관리" 링크(ChatGPT 설정의 사용량 화면)를 보인다. 연결 끊기 확인은 "이 앱의 ChatGPT 연결을 끊는다"는 자기 문구이고, 다른 계정으로 로그인은 확인 없이 바로 한다(PC의 다른 프로그램에 닿지 않는다).
- Codex 관련 안내(`codexNotice`)는 Codex 길에서만 보인다.

**에이전트 모드와 명령어.** 에이전트 모드는 프로그램의 도구가 필요하므로 지금처럼 Claude Code와 Codex만 쓴다. 터미널 명령어와 MCP에는 이 연결을 열지 않는다. 명령어 프로세스는 봉인을 풀 수는 있어도 갱신된 토큰을 다시 봉인해 쓸 수 없고, 앱과 동시에 갱신하면 토큰이 무효가 된다. 명령어에서 `chatgpt`는 늘 `signed-out`이고, `auto`는 지금처럼 Codex로 간다.

## 택하지 않은 것

- **ChatGPT 답을 둘로 나눠 보인다(직접 / Codex).** 사용자가 차이를 알아야 고를 수 있다. 차이는 "프로그램을 설치하느냐"와 "에이전트 모드를 쓰느냐"뿐이라, 질문 단계에서 묻지 않고 길 안의 링크로 둔다.
- **설정의 ChatGPT 카드 하나에 "연결 방식" 선택을 둔다.** 그 선택이 "사용할 AI"와 따로 놀아, Claude까지 걸린 `auto` 순서와 겹친다. 카드를 셋으로 두고 순서로 말한다.
- **Codex를 없애고 직접 연결만 둔다.** 에이전트 모드에는 Codex가 필요하고, 이미 Codex로 쓰는 사람이 많다.
- **도구 호출을 API 형식(`tools`)으로 보낸다.** 요금제 사용 문서가 약속하지 않는다. 실제 계정으로 확인한 뒤 바꿀 수 있다.
- **명령어도 같은 토큰을 쓴다.** 갱신 토큰을 두 프로세스가 나눠 쓰면 한쪽이 무효가 된다. 명령어용으로 따로 로그인하는 길은 쓰임이 확인되면 다시 본다.
- **Claude도 같은 방식으로 연결한다.** Anthropic의 별도 허가가 없으면 약관 위반이다.

## 결과

- 절대 규칙 1을 고쳤다. 지키는 것은 그대로다(Codex의 `~/.codex/auth.json`과 Claude의 로그인 저장소는 읽지도 복사하지도 않고, 앱 화면에 로그인 양식을 만들지 않는다). 더한 것은 "앱 자신이 OpenAI에 등록해 받은 ChatGPT 토큰은 앱이 봉인해 보관한다"이다.
- 문서 내용이 Codex 프로그램을 거치지 않고 이 PC에서 `api.openai.com`으로 바로 간다. `PRIVACY.md`에 적었다.
- 사용자가 ChatGPT 설정 → 사용량에서 이 앱만의 한도를 정할 수 있다. 한도가 차면 앱은 멈추고, 요금이 나가는 쪽으로 가지 않는다.
- 실제 계정으로 확인하지 않은 것: 도구 규약이 요금제 모델에서 잘 도는지, `input_image`를 받는지, 사용량 화면 주소. 테스트는 모두 가짜 응답이다. 저장소 주인이 한 번 로그인해 짧은 요청 몇 번으로 확인한다(`docs/operations.md`의 "실제 구독으로 확인하기").
- 소개 사이트의 연결 도움말(`/connect`)에 `#chatgpt` 절이 필요하다. 앱의 링크가 그 이름을 가리킨다.
- 결정 0032의 "Sign in with ChatGPT는 쓰지 않는다"는 이 결정으로 바뀐다. 에이전트 모드에 대한 나머지는 그대로다.
- OpenAI가 오픈소스 앱의 조건을 바꾸면 이 결정을 다시 본다.
