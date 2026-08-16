import type {
  ReleaseSurfaceSuccessorInputDto,
  ReleaseSurfaceSuccessorPlanDto,
  SurfaceHeadDto
} from '@jooevents/contracts';

export interface FormSurfaceSuccessorPlanningPort {
  planFormSurfaceSuccessors(input: ReleaseSurfaceSuccessorInputDto): {
    readonly plan: ReleaseSurfaceSuccessorPlanDto;
    readonly guardRefs: readonly {
      readonly id: string;
      readonly version: number;
      readonly digest: string;
    }[];
  };
}

export type FormSurfaceSuccessorValidation =
  | { readonly kind: 'ready' }
  | { readonly kind: 'refused' };

export interface FormSurfaceSuccessorValidationPort {
  validateFormSurfaceSuccessors(
    plan: ReleaseSurfaceSuccessorPlanDto
  ): FormSurfaceSuccessorValidation;
}

export interface FormSurfaceSuccessorTransactionPort {
  applyFormSurfaceSuccessors(plan: ReleaseSurfaceSuccessorPlanDto): readonly SurfaceHeadDto[];
}
