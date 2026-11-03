// Curated Ollama models. Sizes are the default (≈Q4) download sizes in GB.
// Edit freely: new releases only need a line here.

export type Use = "chat" | "code" | "reason" | "vision" | "tiny";

export interface CatalogModel {
  id: string;
  name: string;
  /** Total parameters, billions. */
  params: number;
  /** Active parameters per token for Mixture-of-Experts models. */
  active?: number;
  sizeGB: number;
  uses: Use[];
  /** Handles Vietnamese well. */
  vi: boolean;
}

export const CATALOG: CatalogModel[] = [
  { id: "qwen3:0.6b", name: "Qwen3 0.6B", params: 0.6, sizeGB: 0.52, uses: ["tiny", "chat"], vi: true },
  { id: "gemma3:1b", name: "Gemma 3 1B", params: 1, sizeGB: 0.82, uses: ["tiny", "chat"], vi: true },
  { id: "llama3.2:1b", name: "Llama 3.2 1B", params: 1.2, sizeGB: 1.3, uses: ["tiny", "chat"], vi: false },
  { id: "qwen2.5-coder:1.5b", name: "Qwen2.5 Coder 1.5B", params: 1.5, sizeGB: 0.99, uses: ["tiny", "code"], vi: false },
  { id: "qwen3:1.7b", name: "Qwen3 1.7B", params: 1.7, sizeGB: 1.4, uses: ["tiny", "chat", "reason"], vi: true },
  { id: "deepseek-r1:1.5b", name: "DeepSeek-R1 1.5B", params: 1.8, sizeGB: 1.1, uses: ["reason"], vi: false },
  { id: "llama3.2:3b", name: "Llama 3.2 3B", params: 3.2, sizeGB: 2.0, uses: ["chat"], vi: false },
  { id: "qwen2.5-coder:3b", name: "Qwen2.5 Coder 3B", params: 3.1, sizeGB: 1.9, uses: ["code"], vi: false },
  { id: "phi4-mini", name: "Phi-4 mini 3.8B", params: 3.8, sizeGB: 2.5, uses: ["chat", "reason"], vi: false },
  { id: "qwen3:4b", name: "Qwen3 4B", params: 4, sizeGB: 2.5, uses: ["chat", "reason", "code"], vi: true },
  { id: "gemma3:4b", name: "Gemma 3 4B", params: 4.3, sizeGB: 3.3, uses: ["chat", "vision"], vi: true },
  { id: "mistral:7b", name: "Mistral 7B", params: 7.2, sizeGB: 4.4, uses: ["chat"], vi: false },
  { id: "qwen2.5-coder:7b", name: "Qwen2.5 Coder 7B", params: 7.6, sizeGB: 4.7, uses: ["code"], vi: false },
  { id: "deepseek-r1:7b", name: "DeepSeek-R1 7B", params: 7.6, sizeGB: 4.7, uses: ["reason"], vi: false },
  { id: "llama3.1:8b", name: "Llama 3.1 8B", params: 8, sizeGB: 4.9, uses: ["chat"], vi: false },
  { id: "qwen3:8b", name: "Qwen3 8B", params: 8.2, sizeGB: 5.2, uses: ["chat", "reason", "code"], vi: true },
  { id: "deepseek-r1:8b", name: "DeepSeek-R1 8B", params: 8.2, sizeGB: 5.2, uses: ["reason"], vi: true },
  { id: "gemma3:12b", name: "Gemma 3 12B", params: 12.2, sizeGB: 8.1, uses: ["chat", "vision"], vi: true },
  { id: "qwen3:14b", name: "Qwen3 14B", params: 14.8, sizeGB: 9.3, uses: ["chat", "reason", "code"], vi: true },
  { id: "qwen2.5-coder:14b", name: "Qwen2.5 Coder 14B", params: 14.8, sizeGB: 9.0, uses: ["code"], vi: false },
  { id: "phi4", name: "Phi-4 14B", params: 14.7, sizeGB: 9.1, uses: ["chat", "reason"], vi: false },
  { id: "deepseek-r1:14b", name: "DeepSeek-R1 14B", params: 14.8, sizeGB: 9.0, uses: ["reason"], vi: false },
  { id: "gpt-oss:20b", name: "gpt-oss 20B", params: 21, active: 3.6, sizeGB: 14, uses: ["chat", "reason", "code"], vi: true },
  { id: "gemma3:27b", name: "Gemma 3 27B", params: 27.4, sizeGB: 17, uses: ["chat", "vision"], vi: true },
  { id: "qwen3:30b", name: "Qwen3 30B-A3B", params: 30.5, active: 3.3, sizeGB: 19, uses: ["chat", "reason", "code"], vi: true },
  { id: "qwen3-coder:30b", name: "Qwen3 Coder 30B-A3B", params: 30.5, active: 3.3, sizeGB: 19, uses: ["code"], vi: true },
  { id: "qwen3:32b", name: "Qwen3 32B", params: 32.8, sizeGB: 20, uses: ["chat", "reason", "code"], vi: true },
];
