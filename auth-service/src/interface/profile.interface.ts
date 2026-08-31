export interface ProfileResponse {
  id: string;
  email: string;
  name: string;
  phone?: string;
  address?: string;
  avatar_url?: string;
  two_fa_enabled: boolean;
  role: string;
  profile_completion_percentage: number;
}
