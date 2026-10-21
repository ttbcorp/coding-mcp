# coding-mcp

Ollama 로컬 LLM을 활용한 코드 자동 생성 MCP 서버.  
파일 생성·수정·diff 미리보기·워크스페이스 탐색 기능을 MCP Tool/Resource로 노출합니다.
수정사항이 있나 봐야함

## 목차

- [사전 요구사항](#사전-요구사항)
- [설치](#설치)
- [서버 실행](#서버-실행)
- [환경 변수](#환경-변수)
- [MCP 클라이언트 등록](#mcp-클라이언트-등록)
  - [Claude Desktop](#claude-desktop)
  - [Claude Code (CLI)](#claude-code-cli)
  - [커스텀 MCP 클라이언트](#커스텀-mcp-클라이언트)
- [제공 Tools](#제공-tools)
- [제공 Resources](#제공-resources)
- [안전성 정책](#안전성-정책)
- [개발](#개발)

---

## 사전 요구사항

| 항목 | 버전 |
|------|------|
| Node.js | 20 이상 |
| Ollama | 최신 버전 |
| 코딩 모델 | `qwen2.5-coder:14b` (기본값) |

### Ollama 설치 및 모델 준비

```bash
# Ollama 설치 (macOS)
brew install ollama

# 데몬 시작
ollama serve

# 기본 모델 다운로드
ollama pull qwen2.5-coder:14b
```

다른 모델을 사용하려면 환경 변수 `OLLAMA_MODEL`을 변경하세요.

---

## 설치

```bash
git clone https://github.com/ttbcorp/coding-mcp.git coding-mcp
cd coding-mcp
npm install
```

---

## 서버 실행

### 개발 모드 (파일 변경 감지 + 자동 재시작)

```bash
npm run dev
```

### 프로덕션 모드

```bash
npm run build   # TypeScript 컴파일
npm run start   # dist/index.js 실행
```

> 서버는 **stdio** 전송 방식을 사용합니다.  
> 직접 실행해도 터미널에 출력이 없는 것이 정상이며, MCP 클라이언트가 프로세스를 기동해 통신합니다.

---

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama 데몬 주소 |
| `OLLAMA_MODEL` | `qwen2.5-coder:14b` | 코드 생성에 사용할 모델 |
| `WORKSPACE_ROOT` | 실행 디렉토리 (`cwd`) | 파일 읽기·쓰기 허용 루트 경로 (보안 경계) |

`WORKSPACE_ROOT` 외부 경로는 모든 Tool에서 거부됩니다.

---

## MCP 클라이언트 등록

### Claude Desktop

설정 파일 경로:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

**빌드 후 실행 방식 (권장)**

```json
{
  "mcpServers": {
    "coding-mcp": {
      "command": "node",
      "args": ["/절대경로/coding-mcp/dist/index.js"],
      "env": {
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_MODEL": "qwen2.5-coder:14b",
        "WORKSPACE_ROOT": "/Users/me/projects"
      }
    }
  }
}
```

**개발 모드 실행 방식**

```json
{
  "mcpServers": {
    "coding-mcp": {
      "command": "npx",
      "args": ["tsx", "/절대경로/coding-mcp/src/index.ts"],
      "env": {
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_MODEL": "qwen2.5-coder:14b",
        "WORKSPACE_ROOT": "/Users/me/projects"
      }
    }
  }
}
```

설정 파일 저장 후 Claude Desktop을 재시작하면 적용됩니다.

---

### Claude Code (CLI)

프로젝트 로컬 등록 (`.mcp.json`):

```bash
# 프로젝트 루트에서 실행
claude mcp add coding-mcp \
  -e OLLAMA_BASE_URL=http://localhost:11434 \
  -e OLLAMA_MODEL=qwen2.5-coder:14b \
  -e WORKSPACE_ROOT=/Users/me/projects \
  -- node /절대경로/coding-mcp/dist/index.js
```

전역 등록:

```bash
claude mcp add --scope user coding-mcp \
  -e WORKSPACE_ROOT=/Users/me/projects \
  -- node /절대경로/coding-mcp/dist/index.js
```

등록 확인:

```bash
claude mcp list
```

---

### 커스텀 MCP 클라이언트

stdio 전송을 직접 연결하는 경우 다음과 같이 프로세스를 기동합니다:

```js
import { spawn } from "node:child_process";

const proc = spawn("node", ["/절대경로/coding-mcp/dist/index.js"], {
  env: {
    ...process.env,
    WORKSPACE_ROOT: "/Users/me/projects",
    OLLAMA_MODEL: "qwen2.5-coder:14b",
  },
  stdio: ["pipe", "pipe", "inherit"],
});
```

MCP JSON-RPC 메시지를 `proc.stdin`으로 쓰고, `proc.stdout`에서 읽습니다.

---

## 제공 Tools

| Tool | 설명 |
|------|------|
| `generate_file` | 자연어 설명으로 새 파일 생성 |
| `modify_file` | 자연어 지시로 기존 파일 수정 |
| `apply_workspace_write` | 지정 내용을 파일로 직접 저장 |
| `preview_diff` | 변경 전 unified diff 미리보기 |
| `list_workspace_tree` | 워크스페이스 파일 목록 조회 |

모든 Tool은 `project_root` 파라미터를 요구하며, `WORKSPACE_ROOT` 하위 경로만 허용됩니다.

### 사용 예시

```
// generate_file
{
  "project_root": "/Users/me/projects/my-app",
  "path": "src/utils/date.ts",
  "description": "날짜를 'YYYY-MM-DD' 형식으로 포맷하는 유틸리티 함수",
  "language": "typescript"
}

// modify_file
{
  "project_root": "/Users/me/projects/my-app",
  "path": "src/utils/date.ts",
  "instruction": "UTC 오프셋을 받아 타임존 변환을 지원하도록 수정해줘"
}

// preview_diff
{
  "project_root": "/Users/me/projects/my-app",
  "path": "src/utils/date.ts",
  "new_content": "// 수정된 파일 전체 내용"
}
```

---

## 제공 Resources

| Resource URI | 설명 |
|-------------|------|
| `workspace://tree` | 워크스페이스 전체 파일 목록 (JSON) |
| `workspace://file/{path}` | 워크스페이스 내 파일 내용 읽기 |

---

## 안전성 정책

- `WORKSPACE_ROOT` 외부로의 경로 탐색(path traversal) 차단
- 기존 파일 덮어쓰기 시 `overwrite: true` 명시 필요
- 덮어쓰기 전 자동 백업 생성 (`.bak`)
- 바이너리 파일 및 1 MB 초과 파일 차단

---

## 개발

```bash
npm run dev        # 개발 서버 (tsx watch)
npm run test       # 테스트 실행 (vitest)
npm run test:watch # 테스트 감시 모드
npm run lint       # 타입 체크 (tsc --noEmit)
npm run build      # 프로덕션 빌드
```

### 프로젝트 구조

```
src/
  index.ts           # 엔트리포인트 (stdio 전송 연결)
  server/
    index.ts         # MCP 서버 생성 및 Tool/Resource 등록
    tools/           # Tool 핸들러
    resources/       # Resource 핸들러
  services/          # 비즈니스 로직 (CodingTaskService)
  ollama/            # Ollama REST 클라이언트
  workspace/         # 파일시스템 관리 및 경로 검증
  schemas/           # Zod 스키마
tests/               # Vitest 테스트
```
