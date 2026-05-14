# 구글 캘린더 중복 방지 및 동기화 안정화 설계

## 배경

소마 달력 뷰어 크롬 익스텐션의 구글 캘린더 연동 기능에서 중복 이벤트가 발생하고 있다. 현재 중복 추적이 `localStorage.swm_synced_gcal`에만 의존하기 때문에, 다음 상황에서 모두 중복이 생긴다.

1. localStorage가 비워졌을 때 (브라우저 데이터 청소, 시크릿모드, 새 디바이스)
2. `www.swmaestro.ai` ↔ `swmaestro.ai` — 두 origin은 localStorage가 별개
3. 선택 캘린더 변경 후 전체 추가 — `updateGcalEvent`가 옛 `cal`로 PATCH
4. 사용자가 구글 캘린더에서 수동 삭제 — syncedMap엔 남아 update 시도 → 404, fallback 없음

부수적으로 다음 안정성 이슈도 함께 해결한다.

- 401 토큰 만료 시 재시도 없음
- 빈 `} catch {}`로 인한 디버깅 불가
- 자동 동기화 실패 시 사용자 인지 불가
- 데드 코드 (`gcalSynced` 변수)
- `updateGcalEvent`가 빈 location을 덮어쓰지 못함

## 목표

- 구글 캘린더에 같은 강의가 두 번 들어가지 않는다 (localStorage 상태와 무관).
- 401 토큰 만료가 사용자 작업을 깨뜨리지 않는다.
- 동기화 실패가 침묵하지 않는다.

## 비목표 (YAGNI)

- iCalUID/import 메서드 사용
- chrome.storage.sync 마이그레이션
- origin 통일 (www 유무) — extendedProperties로 우회 해결됨
- 강의 카드 단건 추가 버튼의 API화 (현 URL 방식 유지)

## 설계

### Source of Truth 변경

**구글 캘린더 이벤트 자체가 source of truth.** localStorage는 빠른 경로 캐시일 뿐.

이 익스텐션이 생성하는 모든 이벤트는 다음 두 개의 `extendedProperties.private`를 가진다.

- `swmAppId` — `"soma-cal"` 고정. 이 익스텐션이 만든 이벤트만 골라내는 마커.
- `swmKey` — `getLectureKey(l)` 결과 (강의 식별자).

동기화 시작 시 한 번 `events.list`로 현재 캘린더의 우리 이벤트를 모두 조회한다.

```
GET /calendar/v3/calendars/{calId}/events
  ?privateExtendedProperty=swmAppId=soma-cal
  &showDeleted=false
  &maxResults=2500
  &singleEvents=true
```

응답으로 `swmKey → { id, ...meta }` 맵을 만들어 매칭에 사용한다. localStorage 캐시는 이 결과로 재구성한다.

이 방식의 보장:

- localStorage 비어있어도 한 번 조회로 복원
- origin이 바뀌어도 동일 캘린더면 동일 결과
- 다른 디바이스에서 작업해도 충돌 없음
- 선택 캘린더가 바뀌어도 새 캘린더 기준으로 재구축

### 동기화 플로우

#### A. 전체 추가 버튼 (`#swm-gcal-all`)

1. 토큰 획득 (interactive)
2. 현재 선택 캘린더에서 우리 이벤트 list 조회 → `remoteMap: swmKey → eventId`
3. 각 강의 `l`에 대해:
   - `remoteMap[key]` 있음 → `PATCH` (summary/location/start/end)
   - 없음 → `POST` (body에 `extendedProperties.private = { swmAppId, swmKey }` 포함)
4. 성공한 결과로 `swm_synced_gcal` 재작성, `swm_synced_format` 저장
5. 토스트: "N개 추가, M개 업데이트 (K개 실패: ○○ 외)"

#### B. 자동 동기화 (`autoSync`)

현재 진입 조건은 "syncedMap이 비어있지 않을 때"인데, 이는 한 번 localStorage가 청소된 사용자에게는 자동 sync가 영영 안 동작한다는 뜻이다.

변경된 진입 조건:

1. silent 토큰 시도. 없으면 종료.
2. 현재 캘린더의 우리 이벤트 list 조회.
3. 분기:
   - `remoteMap`이 비어있고 `syncedMap`도 비어있음 → **미연동 사용자** → 종료
   - `remoteMap`이 비어있는데 `syncedMap`이 비어있지 않음 → **마이그레이션 전 상태** → 자동 sync는 위험하므로 종료하고 안내 배지: "전체 추가 버튼을 한 번 더 눌러주세요" (마이그레이션은 전체 추가에서 수행)
   - `remoteMap`이 비어있지 않음 → **정상 진행**
4. 정상 진행 시:
   - 새 강의 (`!remoteMap[key]`) → 생성
   - 사라진 강의 (`remoteMap`에는 있는데 현재 강의 목록에 없는 `swmKey`) → 삭제
   - 제목 형식 바뀜 → 매칭된 모든 이벤트 update
5. localStorage 캐시 갱신 (remoteMap 기준)
6. 결과 배지 표시. 실패가 있으면 빨간색 배지로 노출.

#### C. 단건 추가 버튼

현재 `calendar.google.com/render?...` URL 방식 유지. 변경 없음.

### 캘린더 변경 시 처리

`calSelect.onchange`에서:

1. `saveCalId(newId)` (기존)
2. `localStorage.removeItem(SYNC_KEY)` — 캐시 무효화
3. 토스트: "캘린더를 변경했습니다. 이전 캘린더의 이벤트는 유지됩니다. 새 캘린더에 추가하려면 전체 추가 버튼을 누르세요."

옛 캘린더의 이벤트는 의도적으로 두지 않는다. 사용자가 직접 옮긴 경우일 수 있고, 자동 삭제는 데이터 손실 위험이 크다.

### 토큰 401 재시도

API 호출 헬퍼 `gcalFetch(token, url, init)`를 도입:

1. 첫 시도
2. 401이면 `chrome.identity.removeCachedAuthToken({ token })` → `getAuthToken(interactive=false)` → 재시도 1회
3. 그래도 실패면 throw

`createGcalEvent`, `updateGcalEvent`, `deleteGcalEvent`, `fetchCalendarList`, list 조회 모두 이 헬퍼를 통한다. 토큰은 caller가 보유하되, 재시도에서 받은 새 토큰은 caller에게 반환되어 이후 호출에 재사용된다 (호출 루프에서 토큰 변수 갱신).

### 에러 로깅 / UX

- 모든 빈 `} catch {}`를 `} catch (e) { console.warn('[소마 달력] <맥락> 실패:', e); }`로 교체
- `autoSync`의 실패가 1건이라도 있으면 빨간 배지 (`swm-fab-badge` 변형 클래스)
- 전체 추가 토스트가 실패 강의의 첫 1건 제목과 총 실패 수를 함께 표시
- `gcalSynced` 변수 제거
- `updateGcalEvent`에서 location을 항상 보냄 (빈 문자열도 OK)

### 데이터 구조

`localStorage.swm_synced_gcal`의 값 구조는 기존과 동일하게 `{ [lectureKey]: { id, cal } }`을 유지. 이제는 캐시일 뿐이라 잘못되어도 list 조회로 정정 가능.

`extendedProperties.private`는 생성 시점에만 박는다. 기존에 이미 만들어진 이벤트는 `extendedProperties`가 없음 → 마이그레이션:

- 자동 동기화 첫 실행 시 `remoteMap`이 비어있는데 `syncedMap`이 비어있지 않다면:
  - syncedMap의 각 `(key, {id, cal})`에 대해 해당 캘린더에서 `events.get`으로 존재 확인
  - 존재하면 PATCH로 `extendedProperties.private` 추가
  - 404면 무시 (사용자가 삭제했거나 다른 캘린더)
- 또는 더 단순하게: 첫 전체 추가 클릭 시 syncedMap에 있는 이벤트를 PATCH로 마이그레이션

**선택**: 두 번째 방법 (전체 추가 클릭 시 마이그레이션). 자동 동기화는 토큰 확인 후 마이그레이션이 끝났으면 그 결과를 활용. 첫 실행이 가벼워야 부담이 적음.

마이그레이션 절차 (전체 추가 클릭 시):

1. 토큰 획득
2. `remoteMap` 조회 (extendedProperties로)
3. `remoteMap`이 비어있고 `syncedMap`이 비어있지 않으면:
   - syncedMap의 각 항목을 PATCH로 extendedProperties 추가 (현재 선택 캘린더의 항목만)
   - PATCH 후 remoteMap에 추가
   - 404는 무시
4. 이후 정상 플로우 (생성/업데이트) 진행

## 파일 변경 범위

- `content.js` 만 수정 (manifest, background, css 변경 없음)
  - 단, 향후 host_permissions에 `*://www.googleapis.com/*` 패턴 확인 (이미 있음, 변경 없음)

## 테스트 시나리오 (수동)

크롬 익스텐션은 자동화 테스트가 어려우므로 수동 검증.

1. **기본 추가**: 페이지 방문 → 전체 추가 → 캘린더에 N개 들어감.
2. **중복 방지 (localStorage 청소)**: 위 직후 localStorage `swm_synced_gcal` 삭제 → 전체 추가 다시 클릭 → 캘린더에 추가되지 않고 "0개 추가, N개 업데이트" 토스트.
3. **중복 방지 (origin 전환)**: `www.swmaestro.ai`에서 추가 → `swmaestro.ai`로 접속 → 전체 추가 → 중복 없음.
4. **캘린더 변경**: 캘린더 A에 추가 후 캘린더 B로 변경 → 전체 추가 → B에 N개 새로 추가 (A는 그대로 남아있음). 토스트 안내 확인.
5. **수동 삭제 복원**: 캘린더에서 1개 수동 삭제 → 페이지 새로고침 → 자동 동기화로 그 1개만 다시 추가.
6. **제목 형식 변경**: 형식 입력 후 페이지 새로고침 → 모든 이벤트 제목 업데이트 (중복 없음).
7. **401 재시도**: chrome://identity-internals에서 토큰 revoke → 전체 추가 클릭 → 한 번 재인증 후 정상 진행.
8. **실패 알림**: 네트워크 오프라인 상태에서 자동 동기화 → 빨간 배지 노출.
