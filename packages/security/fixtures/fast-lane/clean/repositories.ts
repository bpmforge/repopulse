// Near-misses for slop.repository_over_crud (W18-09).
import type { PrismaClient, User } from '@prisma/client';

// One method does real work — mapping rows to a domain object — so the
// repository earns its keep.
export class AccountRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: string) {
    return this.prisma.account.findUnique({ where: { id } });
  }

  findAll() {
    return this.prisma.account.findMany();
  }

  async balances(ownerId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.account.findMany({ where: { ownerId } });
    return new Map(rows.map((r) => [r.id, r.balance]));
  }
}

// Named queries: each method carries a decision (a literal, an operator).
export class SessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  active() {
    return this.prisma.session.findMany({ where: { revoked: false } });
  }

  expired(now: Date) {
    return this.prisma.session.findMany({ where: { expiresAt: { lt: now } } });
  }

  recent() {
    return this.prisma.session.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
  }
}

// Too small to call a layer.
export class TagRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findAll() {
    return this.prisma.tag.findMany();
  }

  create(name: string) {
    return this.prisma.tag.create({ data: { name } });
  }
}

// Pass-through, but not named as a repository: other rules' business.
export class UserStore {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findAll(): Promise<User[]> {
    return this.prisma.user.findMany();
  }

  delete(id: string) {
    return this.prisma.user.delete({ where: { id } });
  }
}

// A transaction callback is behaviour.
export class TransferRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: string) {
    return this.prisma.transfer.findUnique({ where: { id } });
  }

  findAll() {
    return this.prisma.transfer.findMany();
  }

  move(from: string, to: string, amount: number) {
    return this.prisma.$transaction(async (tx) => {
      await tx.account.update({ where: { id: from }, data: { balance: { decrement: amount } } });
      await tx.account.update({ where: { id: to }, data: { balance: { increment: amount } } });
    });
  }
}
