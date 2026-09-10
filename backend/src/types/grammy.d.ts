import 'grammy';

declare module 'grammy' {
  interface Context {
    session: {
      isAdmin: boolean;
    };
  }
}
