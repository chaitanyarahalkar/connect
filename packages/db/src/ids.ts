import { customAlphabet } from 'nanoid';

const nano = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 20);

export const newId = {
  org: () => `org_${nano()}`,
  membership: () => `mem_${nano()}`,
  project: () => `prj_${nano()}`,
  projectClient: () => `pcl_${nano()}`,
  accessToken: () => `pat_${nano()}`,
  connector: () => `con_${nano()}`,
  connectorSecret: () => `cs_${nano()}`,
  installation: () => `inst_${nano()}`,
  grant: () => `grant_${nano()}`,
  link: () => `link_${nano()}`,
  trigger: () => `trig_${nano()}`,
  webhookEvent: () => `evt_${nano()}`,
  delivery: () => `del_${nano()}`,
  issuance: () => `iss_${nano()}`,
  usage: () => `use_${nano()}`,
  audit: () => `aud_${nano()}`,
  user: () => `usr_${nano()}`,
};
