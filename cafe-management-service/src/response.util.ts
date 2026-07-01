export class ApiResponse<T = any> {
  constructor(
    public readonly data: T | null = null,
    public readonly message?: string,
  ) {}
}
