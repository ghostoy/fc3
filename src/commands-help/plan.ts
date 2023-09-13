export default {
  help: {
    description:
      'Show the differences between the local and remote. \n' + 'Example: \n' + '  $ s3 plan',
    summary: 'Perceive resource change',
    option: [
      [
        '--region <region>',
        '[C-Required] Specify fc region, you can see all supported regions in https://www.alibabacloud.com/help/en/fc/product-overview/region-availability',
      ],
      ['--function-name <functionName>', '[C-Required] Specify function name'],
    ],
  },
};
