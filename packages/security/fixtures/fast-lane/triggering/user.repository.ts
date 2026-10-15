// Fixture for slop.repository_over_crud (W18-09).
import type { PrismaClient, User } from '@prisma/client';

// expect: slop.repository_over_crud
export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findAll(): Promise<User[]> {
    return this.prisma.user.findMany();
  }

  async create(data: Omit<User, 'id'>): Promise<User> {
    return await this.prisma.user.create({ data });
  }

  update(id: string, data: Partial<User>) {
    return this.prisma.user.update({
      where: { id },
      data,
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.user.delete({ where: { id } });
  }
}
