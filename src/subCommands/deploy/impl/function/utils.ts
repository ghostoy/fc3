import _ from 'lodash';
import fs from 'fs';
import path from 'path';
import { yellow } from 'chalk';
import zip from '@serverless-devs/zip';
import { getRootHome } from '@serverless-devs/utils';

import { IFunction, IInputs, ILogConfig, INasConfig, IVpcConfig } from '../../../../interface';
import logger from '../../../../logger';
import { isAuto } from '../../../../utils';
import FC from '../../../../resources/fc';
import Acr from '../../../../resources/acr';
import { FUNCTION_DEFAULT_CONFIG } from '../../../../default/config';
import Sls from '../../../../resources/sls';
import VPC_NAS from '../../../../resources/vpc-nas';
import Ram from '../../../../resources/ram';

type IType = 'code' | 'config' | boolean;
interface IOpts {
  type?: IType;
  yes?: boolean;
  skipPush?: boolean;
}

export default class Utils {
  readonly type: IType;
  readonly baseDir: string;
  readonly skipPush: boolean = false;

  needDeploy?: boolean;
  remote?: any;
  local: IFunction;
  createResource: Record<string, any> = {};
  readonly fcSdk: FC;

  constructor(readonly inputs: IInputs, opts: IOpts) {
    this.type = opts?.type;
    this.needDeploy = opts?.yes;
    this.skipPush = opts?.skipPush;

    logger.debug(`deploy function type: ${this.type}`);

    this.baseDir = path.dirname(inputs.yaml.path || process.cwd());
    logger.debug(`baseDir is: ${this.baseDir}`);

    const local = _.cloneDeep(inputs.props.function);
    this.local = _.defaults(local, FUNCTION_DEFAULT_CONFIG);
    this.fcSdk = new FC(inputs.props.region, inputs.credential);
  }

  /**
   * 获取线上函数配置
   * @returns
   */
  async getRemote() {
    try {
      const remote = await this.fcSdk.getFunction(this.local.functionName, 'simple-unsupported');
      this.remote = remote;
    } catch (ex) {
      logger.debug(`Get remote function config error: ${ex.message}`);
    }
  }

  /**
   * 上传镜像
   */
  async pushImage() {
    if (this.skipPush) {
      logger.debug(`skip push is ${this.skipPush}`);
      return;
    }
    const { image, acrInstanceID } = this.local.customContainerConfig || {};
    if (_.isNil(image)) {
      throw new Error('CustomContainerRuntime must have a valid image URL');
    }
    logger.spin('creating', 'Acr', image);
    const acr = new Acr(this.inputs.props.region, this.inputs.credential);
    try {
      await acr.pushAcr(image, acrInstanceID);
    } catch (err) {
      logger.warn(`push image ${image} error: ${err}`);
    }
    logger.spin('created', 'Acr', image);
  }

  /**
   * 压缩和上传代码包
   */
  async uploadCode() {
    const codeUri = this.local.code;
    if (_.isNil(codeUri)) {
      throw new Error('Code config is empty');
    }
    // 支持 ossBucketName / ossObjectName 配置
    if (typeof codeUri !== 'string') {
      if (!(codeUri?.ossBucketName && codeUri?.ossObjectName)) {
        throw new Error(
          'Code config must be a string or an object containing ossBucketName and ossObject Name',
        );
      }
      return;
    }

    let zipPath: string = path.isAbsolute(codeUri) ? codeUri : path.join(this.baseDir, codeUri);
    logger.debug(`Code path absolute path: ${zipPath}`);

    const needZip = this.assertNeedZip(codeUri);
    logger.debug(`Need zip file: ${needZip}`);

    let generateZipFilePath: string;
    if (needZip) {
      const zipConfig = {
        codeUri: zipPath,
        outputFileName: `${this.inputs.props.region}_${this.local.functionName}_${Date.now()}`,
        outputFilePath: path.join(getRootHome(), '.s', 'fc', 'zip'),
        ignoreFiles: ['.fcignore'],
        logger: logger.instance,
      };
      generateZipFilePath = (await zip(zipConfig)).outputFile;
      zipPath = generateZipFilePath;
    }
    logger.debug(`Zip file: ${zipPath}`);

    const ossConfig = await this.fcSdk.uploadCodeToTmpOss(zipPath);
    logger.debug('ossConfig: ', ossConfig);
    _.set(this.local, 'code', ossConfig);

    if (generateZipFilePath) {
      try {
        fs.rmSync(generateZipFilePath);
      } catch (ex) {
        logger.debug(`Unable to remove zip file: ${zipPath}`);
      }
    }
  }

  /**
   * 生成 auto 资源
   */
  async deployAuto() {
    const region = this.inputs.props.region;
    const credential = this.inputs.credential;
    const functionName = this.local.functionName;

    const { nasAuto, vpcAuto, slsAuto, roleAuto } = this.computeLocalAuto();
    logger.debug(
      `Deploy auto compute local auto, nasAuto: ${nasAuto}; vpcAuto: ${vpcAuto}; slsAuto: ${slsAuto}; roleAuto: ${roleAuto}`,
    );

    if (slsAuto) {
      const sls = new Sls(region, credential);
      const { project, logstore } = await sls.deploy(functionName);
      logger.write(
        yellow(`Created log resource succeeded, please replace logConfig: auto in yaml with:
logConfig:
  enableInstanceMetrics: true
  enableRequestMetrics: true
  logBeginRule: DefaultRegex
  logstore: ${logstore}
  project: ${project}
`),
      );
      this.createResource.sls = { project, logstore };
      _.set(this.local, 'logConfig', {
        enableInstanceMetrics: true,
        enableRequestMetrics: true,
        logBeginRule: 'DefaultRegex',
        logstore,
        project,
      });
    }

    if (roleAuto) {
      const client = new Ram(credential).client;
      const arn = await client.initFcDefaultServiceRole();
      logger.write(
        yellow(`Using role: ${arn}
`),
      );
      this.createResource.role = { arn };

      _.set(this.local, 'role', arn);
    }

    if (nasAuto || vpcAuto) {
      const client = new VPC_NAS(region, credential);
      const localVpcAuto = _.isString(this.local.vpcConfig) ? undefined : this.local.vpcConfig;
      // @ts-ignore: nas auto 会返回 mountTargetDomain 和 fileSystemId
      const { vpcConfig, mountTargetDomain, fileSystemId } = await client.deploy({
        nasAuto,
        vpcConfig: localVpcAuto,
      });

      if (vpcAuto) {
        logger.write(
          yellow(`Created vpc resource succeeded, please manually write vpcConfig to the yaml file:
vpcConfig:
  vpcId: ${vpcConfig.vpcId}
  securityGroupId: ${vpcConfig.securityGroupId}
  vSwitchIds:
    - ${vpcConfig.vSwitchIds.join('   - \n')}
`),
        );
        this.createResource.vpc = vpcConfig;
        _.set(this.local, 'vpcConfig', vpcConfig);
      }

      if (nasAuto) {
        logger.write(
          yellow(`Created nas resource succeeded, please replace nasConfig: auto in yaml with:
nasConfig:
  groupId: 0
  userId: 0
  mountPoints:
    - serverAddr: ${mountTargetDomain}:/${functionName}
      mountDir: /mnt/${functionName}
      enableTLS: false
`),
        );
        this.createResource.nas = { mountTargetDomain, fileSystemId };
        _.set(this.local, 'nasConfig', {
          groupId: 0,
          userId: 0,
          mountPoints: [
            {
              serverAddr: `${mountTargetDomain}:/${functionName}`,
              mountDir: `/mnt/${functionName}`,
              enableTLS: false,
            },
          ],
        });
      }
    }
  }

  /**
   * 判断是否需要压缩代码
   */
  assertNeedZip(codeUri: string): boolean {
    // 如果 .jar 结尾
    //    custom runtime 并且启动命令包含 java -jar 就需要压缩
    //    官方的 runtime，那么不需要压缩
    if (codeUri.endsWith('.jar')) {
      const runtime = this.local.runtime;
      const command = _.get(this.local, 'customRuntimeConfig.command', []);
      const args = _.get(this.local, 'customRuntimeConfig.args', []);

      const commandStr = `${_.join(command, ' ')} ${_.join(args, ' ')}`;
      if (FC.isCustomRuntime(runtime) && commandStr.includes('java -jar')) {
        return true;
      }
      return false;
    }

    return !(codeUri.endsWith('.zip') || codeUri.endsWith('.war'));
  }

  /**
   * 计算当前local那些资源是 auto
   * @returns
   */
  computeLocalAuto() {
    const nasAuto = isAuto(this.local.nasConfig);
    const vpcAuto = isAuto(this.local.vpcConfig) || (!this.local.vpcConfig && nasAuto);
    const slsAuto = isAuto(this.local.logConfig);
    const roleAuto =
      isAuto(this.local.role) || (_.isNil(this.local.role) && (nasAuto || vpcAuto || slsAuto || FC.isCustomContainerRuntime(this.local?.runtime)));
    return { nasAuto, vpcAuto, slsAuto, roleAuto };
  }

  /**
   * 获取线上资源配置
   */
  getRemoveResourceConfig() {
    const remoteNasConfig = _.get(this.remote, 'nasConfig') as INasConfig;
    const remoteVpcConfig = _.get(this.remote, 'vpcConfig') as IVpcConfig;
    const remoteLogConfig = _.get(this.remote, 'logConfig') as ILogConfig;
    const remoteRole = _.get(this.remote, 'role');
    return { remoteNasConfig, remoteVpcConfig, remoteLogConfig, remoteRole };
  }
}
