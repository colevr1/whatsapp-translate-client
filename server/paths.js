import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = process.env.WA_DATA_DIR || path.join(ROOT, 'data')
export const AUTH_DIR = path.join(DATA_DIR, 'auth')
export const MEDIA_DIR = path.join(DATA_DIR, 'media')
export const PUBLIC_DIR = path.join(ROOT, 'public')
