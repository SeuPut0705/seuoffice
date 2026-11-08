/**
 * Where the ChatGPT connection keeps its tokens: one file in the app's data
 * folder, `chatgpt-connection.json`. The tokens are the app's own (OpenAI
 * issued them to this app's registration), never a vendor program's login.
 *
 * - The access, refresh and ID tokens are sealed with the same codec as the
 *   keys in ai-settings.json (decision 0063): Windows and a real Linux keyring
 *   seal, macOS keeps them plain in the folder only its account can read.
 *   A sealed token that cannot be opened reads as no session.
 * - The file is written whole, to a temporary name first and then renamed, with
 *   owner-only permissions where the system has them.
 * - No e-mail address is written. The account's stable id (`subject`) is, so a
 *   later sign-in can be told to be the same account.
 * - `hostId` names this installation to OpenAI and outlives a sign-out; the
 *   issued `clientId` outlives an ended session, so signing the same account in
 *   again reuses its registration.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openSecretValue, sealSecretValue } from '../settings-secrets'

export const CHATGPT_CONNECTION_FILE = 'chatgpt-connection.json'

export interface ChatGptSession {
  accessToken: string
  refreshToken: string
  /** epoch milliseconds */
  expiresAt: number
  scopes: string[]
  idToken?: string | undefined
}

export interface ChatGptConnectionRecord {
  /** `urn:uuid:…`, made once per installation */
  hostId: string
  /** the id OpenAI issued at the last sign-in; absent until one */
  clientId?: string | undefined
  /** the signed-in account's stable id */
  subject?: string | undefined
  /** absent when signed out */
  session?: ChatGptSession | undefined
}

export interface ChatGptConnectionStore {
  read(): Promise<ChatGptConnectionRecord>
  write(record: ChatGptConnectionRecord): Promise<void>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const HOST_ID = /^urn:uuid:[0-9a-f-]{36}$/i
const CLIENT_ID = /^[A-Za-z0-9._-]{1,256}$/

export function newChatGptHostId(): string {
  return `urn:uuid:${randomUUID()}`
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function sessionOf(value: unknown): ChatGptSession | undefined {
  if (!isRecord(value)) return undefined
  const accessToken = openSecretValue(stringField(value.accessToken) ?? '')
  const refreshToken = openSecretValue(stringField(value.refreshToken) ?? '')
  const idToken = openSecretValue(stringField(value.idToken) ?? '')
  const expiresAt = typeof value.expiresAt === 'number' ? value.expiresAt : 0
  const scopes = Array.isArray(value.scopes)
    ? value.scopes.filter((s): s is string => typeof s === 'string')
    : []
  // a token that cannot be opened (another PC, another account) is no session
  if (!accessToken || !refreshToken) return undefined
  return { accessToken, refreshToken, expiresAt, scopes, ...(idToken ? { idToken } : {}) }
}

/** The stored file as the app understands it; anything broken reads as a fresh host */
export function chatGptConnectionOf(value: unknown): ChatGptConnectionRecord {
  if (!isRecord(value)) return { hostId: newChatGptHostId() }
  const hostId = stringField(value.hostId)
  const clientId = stringField(value.clientId)
  const subject = stringField(value.subject)
  const session = sessionOf(value.session)
  return {
    hostId: hostId && HOST_ID.test(hostId) ? hostId : newChatGptHostId(),
    ...(clientId && CLIENT_ID.test(clientId) ? { clientId } : {}),
    ...(subject && subject.length <= 256 ? { subject } : {}),
    ...(session ? { session } : {}),
  }
}

/** The record as it goes to disk: tokens sealed when this PC can */
export function storedChatGptConnection(record: ChatGptConnectionRecord): Record<string, unknown> {
  return {
    hostId: record.hostId,
    ...(record.clientId ? { clientId: record.clientId } : {}),
    ...(record.subject ? { subject: record.subject } : {}),
    ...(record.session
      ? {
          session: {
            accessToken: sealSecretValue(record.session.accessToken),
            refreshToken: sealSecretValue(record.session.refreshToken),
            ...(record.session.idToken ? { idToken: sealSecretValue(record.session.idToken) } : {}),
            expiresAt: record.session.expiresAt,
            scopes: record.session.scopes,
          },
        }
      : {}),
  }
}

/**
 * The file store in `dataDir`. A missing or unreadable file is a fresh host,
 * whose id is written with the first record saved.
 */
export function createChatGptConnectionFileStore(dataDir: string): ChatGptConnectionStore {
  const path = join(dataDir, CHATGPT_CONNECTION_FILE)
  let fresh: ChatGptConnectionRecord | undefined
  return {
    async read() {
      try {
        return chatGptConnectionOf(JSON.parse(await readFile(path, 'utf8')) as unknown)
      } catch {
        // the same new host id for every read until one is written
        fresh ??= { hostId: newChatGptHostId() }
        return { ...fresh }
      }
    },
    async write(record) {
      await mkdir(dataDir, { recursive: true })
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, `${JSON.stringify(storedChatGptConnection(record), null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        })
        await rename(temp, path)
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
      fresh = undefined
    },
  }
}

/** A store in memory, for tests and for processes that must not touch the disk */
export function createChatGptConnectionMemoryStore(
  initial?: ChatGptConnectionRecord,
): ChatGptConnectionStore & { current(): ChatGptConnectionRecord } {
  let record: ChatGptConnectionRecord = initial ?? { hostId: newChatGptHostId() }
  return {
    read: async () => structuredClone(record),
    write: async (next) => {
      record = structuredClone(next)
    },
    current: () => structuredClone(record),
  }
}
