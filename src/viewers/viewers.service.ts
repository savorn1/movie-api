import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DbTime } from '../common/db-time';
import { displayPhone, normalizePhone } from './phone';
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from './password';
import type {
  ChangePasswordDto,
  IdentityDto,
  LoginDto,
  RegisterDto,
} from './viewers.dto';

/** A viewer as RuengFlix sees it; never the password hash */
export interface ViewerView {
  id: number;
  /** "012 345 678"; null for accounts made with Telegram or Google */
  phone: string | null;
  /** Whether phone + password sign-in works (and the password can be changed) */
  hasPassword: boolean;
  /** Telegram user id: also the chat the bot messages for this viewer's alerts */
  telegramId: number | null;
  telegramUsername: string | null;
  googleEmail: string | null;
  photoUrl: string | null;
  displayName: string;
  disabled: boolean;
  /** RuengFlix sessions remember this; a different value means "signed out everywhere" */
  sessionVersion: number;
  createdAt: string;
}

/** Largest library document kept per viewer (the browser's copy is far smaller in practice) */
export const MAX_LIBRARY_BYTES = 256 * 1024;

type DbViewer = {
  id: bigint;
  phone: string | null;
  passwordHash: string | null;
  telegramId: bigint | null;
  telegramUsername: string | null;
  googleEmail: string | null;
  photoUrl: string | null;
  displayName: string;
  disabled: boolean;
  sessionVersion: number;
  createdAt: Date;
};

/**
 * RuengFlix viewer accounts (VideoLingo's V19 and V20 tables): phone + password, Telegram or Google.
 * Errors carry a `code` so RuengFlix can show its own Khmer message: PHONE_INVALID, PHONE_TAKEN,
 * WRONG_LOGIN, DISABLED, WRONG_PASSWORD, NO_PASSWORD, IDENTITY_TAKEN.
 */
@Injectable()
export class ViewersService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DbTime) private readonly time: DbTime,
  ) {}

  async register(r: RegisterDto): Promise<ViewerView> {
    const phone = normalizePhone(r.phone);
    if (!phone) {
      throw new BadRequestException({
        code: 'PHONE_INVALID',
        message: 'Not a Cambodian phone number',
      });
    }
    const displayName = r.displayName.trim().replace(/\s+/g, ' ');
    if (!displayName) {
      throw new BadRequestException({
        code: 'NAME_REQUIRED',
        message: 'Enter a name',
      });
    }
    try {
      const v = await this.prisma.viewer.create({
        data: {
          phone,
          displayName,
          passwordHash: await hashPassword(r.password),
          createdAt: this.time.toWall(new Date()),
          lastLoginAt: this.time.toWall(new Date()),
        },
      });
      return this.view(v);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'PHONE_TAKEN',
          message: 'That phone number already has an account',
        });
      }
      throw err;
    }
  }

  async login(l: LoginDto): Promise<ViewerView> {
    const phone = normalizePhone(l.phone);
    const v = phone
      ? await this.prisma.viewer.findUnique({ where: { phone } })
      : null;
    // Check a hash either way, so an unknown phone takes as long as a wrong password
    const ok = await verifyPassword(
      l.password,
      v?.passwordHash ?? (await DUMMY_HASH_PROMISE),
    );
    if (!v || !ok) {
      throw new UnauthorizedException({
        code: 'WRONG_LOGIN',
        message: 'Wrong phone number or password',
      });
    }
    this.refuseDisabled(v);
    await this.prisma.viewer.update({
      where: { id: v.id },
      data: { lastLoginAt: this.time.toWall(new Date()) },
    });
    return this.view(v);
  }

  /**
   * Sign in with a verified Telegram or Google account: the viewer it belongs to, or a new viewer.
   * With `linkTo`, the account is added to that viewer instead, unless another viewer already has it.
   * The display name is only set on a new account; the username, email and photo are refreshed.
   */
  async identity(i: IdentityDto): Promise<ViewerView> {
    const key = identityKey(i);
    const profile = {
      ...(i.provider === 'telegram'
        ? { telegramUsername: i.username || null }
        : { googleEmail: i.email || null }),
      ...(i.photoUrl ? { photoUrl: i.photoUrl } : {}),
      lastLoginAt: this.time.toWall(new Date()),
    };
    const owner = await this.prisma.viewer.findUnique({ where: key });

    if (i.linkTo != null) {
      const target = await this.require(i.linkTo);
      if (owner && owner.id !== target.id) {
        throw new ConflictException({
          code: 'IDENTITY_TAKEN',
          message: `That ${i.provider} account belongs to another viewer`,
        });
      }
      this.refuseDisabled(target);
      return this.view(
        await this.prisma.viewer.update({
          where: { id: target.id },
          data: { ...key, ...profile },
        }),
      );
    }

    if (owner) {
      this.refuseDisabled(owner);
      return this.view(
        await this.prisma.viewer.update({
          where: { id: owner.id },
          data: profile,
        }),
      );
    }

    try {
      return this.view(
        await this.prisma.viewer.create({
          data: {
            ...key,
            ...profile,
            displayName: cleanName(i.displayName),
            createdAt: this.time.toWall(new Date()),
          },
        }),
      );
    } catch (err) {
      // Two first sign-ins at once: the other one created it
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const created = await this.prisma.viewer.findUnique({ where: key });
        if (created) return this.view(created);
      }
      throw err;
    }
  }

  async get(id: number): Promise<ViewerView> {
    return this.view(await this.require(id));
  }

  /**
   * Changes the password and signs every other session out; returns the new session version. With
   * `reset`, the current password isn't asked: RuengFlix sends it only right after the viewer proved
   * who they are with Telegram or Google ("forgot password").
   */
  async changePassword(id: number, c: ChangePasswordDto): Promise<ViewerView> {
    const v = await this.require(id);
    if (!v.passwordHash) {
      throw new BadRequestException({
        code: 'NO_PASSWORD',
        message: 'This account signs in with Telegram or Google',
      });
    }
    if (!c.reset && !(await verifyPassword(c.current ?? '', v.passwordHash))) {
      throw new UnauthorizedException({
        code: 'WRONG_PASSWORD',
        message: 'The current password is wrong',
      });
    }
    const updated = await this.prisma.viewer.update({
      where: { id: v.id },
      data: {
        passwordHash: await hashPassword(c.next),
        sessionVersion: { increment: 1 },
      },
    });
    return this.view(updated);
  }

  /**
   * Deletes the account: its library, wallet, unlocks, comments, check-ins and Telegram alerts go too.
   * Orders stay for the accounts, without the viewer. Browser push subscriptions lose the link.
   */
  async remove(id: number) {
    const v = await this.require(id);
    await this.prisma.$transaction(async (tx) => {
      if (v.telegramId != null) {
        await tx.$executeRaw`delete from streaming_follows where chat_id = ${v.telegramId}`;
      }
      await tx.viewer.delete({ where: { id: v.id } });
    });
    return { deleted: true };
  }

  async library(id: number): Promise<{
    data: Record<string, unknown> | null;
    updatedAt: string | null;
  }> {
    await this.require(id);
    const row = await this.prisma.viewerLibrary.findUnique({
      where: { viewerId: BigInt(id) },
    });
    if (!row) return { data: null, updatedAt: null };
    let data: Record<string, unknown> | null = null;
    try {
      data = JSON.parse(row.dataJson) as Record<string, unknown>;
    } catch {
      // A damaged copy is replaced by the browser's on its next save
    }
    return {
      data,
      updatedAt: this.time.toInstant(row.updatedAt).toISOString(),
    };
  }

  async saveLibrary(
    id: number,
    data: Record<string, unknown>,
  ): Promise<{ updatedAt: string }> {
    await this.require(id);
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > MAX_LIBRARY_BYTES) {
      throw new PayloadTooLargeException('Library is too large');
    }
    const now = new Date();
    const wall = this.time.toWall(now);
    await this.prisma.viewerLibrary.upsert({
      where: { viewerId: BigInt(id) },
      create: { viewerId: BigInt(id), dataJson: json, updatedAt: wall },
      update: { dataJson: json, updatedAt: wall },
    });
    return { updatedAt: now.toISOString() };
  }

  private async require(id: number) {
    const v = await this.prisma.viewer.findUnique({
      where: { id: BigInt(id) },
    });
    if (!v) throw new NotFoundException('Viewer not found');
    return v;
  }

  private refuseDisabled(v: { disabled: boolean }) {
    if (v.disabled) {
      throw new ForbiddenException({
        code: 'DISABLED',
        message: 'This account has been disabled',
      });
    }
  }

  private view(v: DbViewer): ViewerView {
    return {
      id: Number(v.id),
      phone: v.phone ? displayPhone(v.phone) : null,
      hasPassword: !!v.passwordHash,
      telegramId: v.telegramId == null ? null : Number(v.telegramId),
      telegramUsername: v.telegramUsername,
      googleEmail: v.googleEmail,
      photoUrl: v.photoUrl,
      displayName: v.displayName,
      disabled: v.disabled,
      sessionVersion: v.sessionVersion,
      createdAt: this.time.toInstant(v.createdAt).toISOString(),
    };
  }
}

/** The unique column a Telegram or Google account is found by */
export function identityKey(i: Pick<IdentityDto, 'provider' | 'subject'>) {
  if (i.provider === 'telegram') {
    if (!/^\d{1,19}$/.test(i.subject)) {
      throw new BadRequestException('A Telegram id is a number');
    }
    return { telegramId: BigInt(i.subject) };
  }
  return { googleSub: i.subject };
}

/** A provider's name as the display name: spaces tidied, cut to 60 characters, never empty */
export function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 60).trim() || 'អ្នកមើល';
}
