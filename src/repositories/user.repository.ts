import { Db } from '@/repositories/db';

export default class UserRepository {
  findById(db: Db, id: string) {
    return db.user.findUnique({ where: { id } });
  }

  findByUsername(db: Db, username: string) {
    return db.user.findUnique({ where: { username } });
  }

  findByEmail(db: Db, email: string) {
    return db.user.findUnique({ where: { email } });
  }

  findByOAuthAccount(db: Db, provider: string, providerAccountId: string) {
    return db.oAuthAccount
      .findUnique({
        where: {
          provider_provider_account_id: { provider, provider_account_id: providerAccountId },
        },
        include: { user: true },
      })
      .then((account) => account?.user ?? null);
  }

  create(db: Db, data: { email: string; username: string; display_name: string }) {
    return db.user.create({ data });
  }

  linkOAuthAccount(db: Db, userId: string, provider: string, providerAccountId: string) {
    return db.oAuthAccount.create({
      data: { user_id: userId, provider, provider_account_id: providerAccountId },
    });
  }

  update(db: Db, id: string, data: { display_name?: string; username?: string }) {
    return db.user.update({ where: { id }, data });
  }
}
