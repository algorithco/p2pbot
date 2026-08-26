// src/types/express.d.ts
import type { TgUser } from '../auth/initData';

declare global {
  namespace Express {
    interface Request {
      user?: TgUser;
      authMode?: string;
    }
  }
}
