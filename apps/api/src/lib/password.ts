// SPDX-License-Identifier: Apache-2.0

import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

const DUMMY_HASH = "$2a$12$e8Y7z9zJzN0N4cZ4m7wK9e6gI3bU7pS1yL5tF8jG0hW2xV4kO6rTq";

export async function verifyPasswordDummy(password: string): Promise<boolean> {
  await bcrypt.compare(password, DUMMY_HASH);
  return false;
}
