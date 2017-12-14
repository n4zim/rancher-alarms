import RancherClient from './rancher';
import resolveConfig from './config';
import ServiceHealthMonitor from './monitor';
import {isArray, some, keys, pluck, find, invoke, pairs, extend, merge, values} from 'lodash';
import {info, trace, error} from './log';
import Promise, {all} from 'bluebird';
import assert from 'assert';

(async () => {
  const config = await resolveConfig();

  info(`started with config:\n${JSON.stringify(config, null, 4)}`);
  assert(config.pollServicesInterval, '`pollServicesInterval` is missing');
  if (config.filter) {
    assert(isArray(config.filter), '`filters` should be of type Array');
  }

  const rancher = new RancherClient(config.rancher);
  const stacks = (await rancher.getStacks())
    .filter(stack => !stack.system) // ignore `system: true` stacks
  trace(`loaded stacks from API\n${JSON.stringify(stacks, null, 4)}`)
  let stacksById = (stacks).reduce((map, {name, id}) => {
    map[id] = name;
    return map;
  }, {});

  const services = (await rancher.getServices())
    .filter(isServiceIncomplete)
    .filter(globalServiceFilterPredicate)
    .filter(runningServicePredicate)
    .filter(s => keys(stacksById).indexOf(s.environmentId) !== -1);
  trace(`loaded services from API\n${JSON.stringify(services, null, 4)}`)
  let systemServicesIds = [] // cache of system services we will ignore

  const monitors = await all(services.map(initServiceMonitor));
  info('monitors inited:');
  for (let m of monitors) {
    info(m.toString());
  }
  invoke(values(monitors), 'start');

  while(true) {
    await Promise.delay(config.pollServicesInterval);
    await updateMonitors();
  }

  async function initServiceMonitor(service) {
    const {name, environmentId} = service;
    const serviceFullName =  stacksById[environmentId].toLowerCase() + '/' + name.toLowerCase();

    const targets = extend({}, config.notifications['*'] && config.notifications['*'].targets, config.notifications[serviceFullName] && config.notifications[serviceFullName].targets);

    for(let [targetName, targetConfig] of pairs(targets)) {
      if (config.targets[targetName]) {
        merge(targetConfig, config.targets[targetName]);
      }
    }

    const healthcheck = merge({}, config.notifications['*'] && config.notifications['*'].healthcheck, config.notifications[serviceFullName] && config.notifications[serviceFullName].healthcheck);
    return new ServiceHealthMonitor({
      stackName: stacksById[environmentId],
      rancherClient: rancher,
      service,
      healthcheck,
      targets,
      templates: config.templates || {}
    });
  }

  async function updateMonitors() {
    const availableServices = (await rancher.getServices())
      .filter(isServiceIncomplete)
      .filter(globalServiceFilterPredicate);
    const monitoredServices = pluck(monitors, 'service');
    trace(`updating monitors`);

    //check if there are new services running
    for (let s of availableServices.filter(runningServicePredicate)) {
      if (systemServicesIds.indexOf(s.id) !== -1) {
        trace(`service id=${s.id} name=${s.name} is system, ignoring...`);
        continue
      }

      if (!find(monitoredServices, {id: s.id})) {
        if (!s.environmentId) {
          // some services doesn't have `environmentId` property. we will skip these so far (I suppose those are internal Rancher services)
          trace(`service id=${s.id} name=${s.name} has no environmentId property, skipping... data=${JSON.stringify(s, null, 4)}`);
          continue;
        }

        let stackName = stacksById[s.environmentId];
        if (!stackName) {
          const stack = await rancher.getStack(s.environmentId)
          if (stack.system) {
            systemServicesIds.push(s.id)
            trace(`service id=${s.id} name=${s.name} is system, skipping... data=${JSON.stringify(s, null, 4)}`);
            continue;
          }
          // we found new `user` stack, add it to cache
          stackName = stacksById[stack.id] = stack.name
        }
        info(`discovered new running service, creating monitor for: ${stackName}/${s.name}`);
        const monitor = await initServiceMonitor(s);
        info(`new monitor up ${monitor}`);
        monitors.push(monitor);
        monitor.start();
      }
    }

    //check if there are monitors polling stopped service
    for (let s of availableServices.filter((s) => (!runningServicePredicate(s)))) {
      let monitoredService, monitor;

      if (monitoredService = find(monitoredServices, {id: s.id})) {
        monitor = find(monitors, {service: monitoredService});
        info(`stopping ${monitoredService.name} due to ${s.state} state`);
        monitors.splice(monitors.indexOf(monitor), 1);
        monitor.stop();
      }
    }
  }

  /**
   * Do the service have a name and an environmentId ?
   * @param service
     */
  function isServiceIncomplete(service) {
    if(typeof service === 'undefined') return false;
    if(typeof service.name === 'undefined') return false;
    if(typeof stacksById[service.environmentId] === 'undefined') return false;
    return true;
  }
  
  /**
   * Should we monitor this service?
   * @param service
     */
  function runningServicePredicate(service) {
    return ['active', 'upgraded', 'upgrading', 'updating-active'].indexOf(service.state) !== -1;
  }

  function globalServiceFilterPredicate(service) {
    const fullName = stacksById[service.environmentId] + '/' + service.name;

    if (config.filter) {
      const matched = some(config.filter, (f) => fullName.match(new RegExp(f)));

      if (matched) {
        return true;
      } else {
        trace(`${fullName} ignored due to global filter setup('filter' config option)`)
      }
    } else {
      return true;
    }
  }

})();

process.on('unhandledRejection', handleError);

function handleError(err) {
  error(err);
  process.exit(1);
}
