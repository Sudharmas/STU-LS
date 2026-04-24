export type UserRole =
  | "platform_admin"
  | "super_admin"
  | "department_admin"
  | "lecturer"
  | "student";

export interface UserSummary {
  id: number;
  username: string;
  role: UserRole;
  department: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface LoginResult {
  user: UserSummary;
}
