export interface FieldError {
  /** JSON path into the request, e.g. `marks[3].obtainedMarks`. */
  field: string;
  code: string;
  message: string;
  params?: Record<string, unknown>;
}
