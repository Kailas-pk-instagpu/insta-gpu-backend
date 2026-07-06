export interface AuthUserResponse {
  id: string;
  name: string;
  role: string;
  branch_id: string | null;
}

export interface LoginResponse {
  requires2fa: boolean;
  tempToken?: string;
  token?: string;
  user?: AuthUserResponse;
}

export interface Verify2faResponse {
  token: string;
  user: AuthUserResponse;
}
