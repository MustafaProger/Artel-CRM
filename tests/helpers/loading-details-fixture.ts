import type { EtrnLoadingDetails } from '../../web/src/etrn-model';

/** Explicitly synthetic facts for one loading operation; never production defaults. */
export const syntheticLoadingDetails = (): EtrnLoadingDetails => ({
  basis: { name: 'Синтетическое поручение погрузки', number: 'TEST-LOADING-1', date: '2025-03-01', issuerInns: ['7707083893'] },
  worker: { surname: 'ПогрузчикТестовый', name: 'Тест', patronymic: '', position: 'Синтетический оператор', authority: 'job_duties' },
});
