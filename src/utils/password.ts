// src/utils/password.ts
// Hashing de senha com bcryptjs (JS puro — evita build nativo no Windows).
import bcrypt from 'bcryptjs'

const SALT_ROUNDS = 10

/** Gera o hash bcrypt de uma senha em texto puro. */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS)
}

/** Verifica se a senha em texto puro corresponde ao hash bcrypt. */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}
