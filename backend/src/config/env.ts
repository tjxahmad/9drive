import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

const emptyToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value)

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_PORT: z.coerce.number().default(4000),
  // Network interface to listen on. 127.0.0.1 keeps the API reachable only from this computer.
  HOST: z.string().min(1).default('127.0.0.1'),
  // Single-owner mode: only this email can register/login. When empty, the first account created becomes the only owner.
  OWNER_EMAIL: z.preprocess(emptyToUndefined, z.string().trim().email().optional()),
  FRONTEND_URL: z.string().url(),
  // Placeholder values from the example files are rejected so the app never runs with publicly known secrets.
  JWT_ACCESS_SECRET: z.string().min(32).refine((value) => !value.startsWith('change-this'), 'Set a random JWT_ACCESS_SECRET.'),
  TOKEN_ENCRYPTION_KEY: z.string().min(32).refine((value) => !value.startsWith('change-this'), 'Set a random TOKEN_ENCRYPTION_KEY.'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  MAX_UPLOAD_BYTES: z.coerce.number().default(5 * 1024 * 1024 * 1024),
  RECAPTCHA_SECRET_KEY: z.string().optional(),
})

export const env = envSchema.parse(process.env)
