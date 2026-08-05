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

// Hash fixo (não corresponde a nenhuma senha real) — usado só pra pagar o
// mesmo custo de bcrypt quando o usuário não existe/está inativo, fechando
// o timing side-channel que permitia descobrir e-mails cadastrados medindo
// o tempo de resposta do login (~150-200ms de diferença, confirmado em teste).
const DUMMY_HASH = bcrypt.hashSync('dummy-timing-fix', SALT_ROUNDS)

/** Gasta o mesmo tempo de um bcrypt.compare real, sem revelar nada — chamar
 * no branch de "usuário não encontrado" dos logins, descartando o resultado. */
export async function verifyPasswordDummy(plain: string): Promise<void> {
  await bcrypt.compare(plain, DUMMY_HASH)
}
