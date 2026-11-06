
export type CompletionRequest = {
  model?: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  max_tokens?: number;
};

export type GatewayErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ERROR";

export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: GatewayErrorCode,
    public readonly publicMessage: string
  ) {
    super(publicMessage);
    this.name = "GatewayError";
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.publicMessage
      }
    };
  }
}

export type ModelRouterOptions = {
  primaryUrl: string;
  backupUrl: string;
  primaryTimeoutMs?: number;
  backupTimeoutMs?: number;
};

type ProviderResponse = {
  id?: string;
  choices?: unknown[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export class ModelRouter {
  private readonly primaryTimeoutMs: number;
  private readonly backupTimeoutMs: number;

  constructor(private readonly options: ModelRouterOptions) {
    this.primaryTimeoutMs =
      options.primaryTimeoutMs ?? 3000;

    this.backupTimeoutMs =
      options.backupTimeoutMs ?? 5000;
  }

  private async callProvider(
    url: string,
    request: CompletionRequest,
    timeoutMs: number
  ): Promise<ProviderResponse> {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      if (response.status === 429) {
        throw new GatewayError(
          429,
          "PROVIDER_UNAVAILABLE",
          "Model provider is rate limited"
        );
      }

      if (!response.ok) {
        throw new GatewayError(
          502,
          "PROVIDER_ERROR",
          "Model provider request failed"
        );
      }

      const data: unknown = await response.json();

      if (
        typeof data !== "object" ||
        data === null ||
        !("choices" in data) ||
        !Array.isArray(data.choices)
      ) {
        throw new GatewayError(
          502,
          "PROVIDER_ERROR",
          "Invalid model provider response"
        );
      }

      return data as ProviderResponse;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GatewayError(
          504,
          "PROVIDER_TIMEOUT",
          "Model provider timed out"
        );
      }

      if (error instanceof GatewayError) {
        throw error;
      }

      throw new GatewayError(
        502,
        "PROVIDER_UNAVAILABLE",
        "Model provider is unavailable"
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async complete(
    request: CompletionRequest
  ): Promise<{
    provider: "primary" | "backup";
    response: ProviderResponse;
  }> {
    try {
      const response = await this.callProvider(
        this.options.primaryUrl,
        request,
        this.primaryTimeoutMs
      );

      return {
        provider: "primary",
        response
      };
    } catch (error) {
      const shouldFallback =
        error instanceof GatewayError &&
        (
          error.status === 429 ||
          error.code === "PROVIDER_TIMEOUT"
        );

      if (!shouldFallback) {
        throw error;
      }

      try {
        const response = await this.callProvider(
          this.options.backupUrl,
          request,
          this.backupTimeoutMs
        );

        return {
          provider: "backup",
          response
        };
      } catch {
        throw new GatewayError(
          503,
          "PROVIDER_UNAVAILABLE",
          "All model providers are unavailable"
        );
      }
    }
  }
}
