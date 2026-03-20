// ============================================================
// Shared API Types
// ============================================================

export interface ApiResponse<T = unknown> {
  success: true;
  data: T;
  meta?: PaginationMeta;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// Application pipeline states
export type ApplicationPipelineStatus =
  | 'PENDING'
  | 'APPLYING'
  | 'APPLIED'
  | 'UNDER_REVIEW'
  | 'INTERVIEW'
  | 'OFFER'
  | 'REJECTED'
  | 'WITHDRAWN'
  | 'FAILED';

// Job match recommendation
export type MatchRecommendation = 'YES' | 'MAYBE' | 'NO';

// Platform types
export type JobPlatform =
  | 'LINKEDIN'
  | 'INDEED'
  | 'NAUKRI'
  | 'WELLFOUND'
  | 'COMPANY_PAGE'
  | 'GLASSDOOR'
  | 'OTHER';
