import { z } from 'zod';

export const UserDTO = z.object({
  id: z.string(),
  email: z.string().email(),
  display_name: z.string(),
  roles: z.array(z.string()),
  avatar_media_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string()
});

export const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(80)
});

export const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128)
});

export const RefreshBody = z.object({
  refresh_token: z.string().min(20)
});

export const UpdateProfileBody = z.object({
  displayName: z.string().min(1).max(80).optional(),
  avatarMediaId: z.string().nullable().optional()
});

export const ChangePasswordBody = z.object({
  oldPassword: z.string().min(8).max(128),
  newPassword: z.string().min(8).max(128)
});
