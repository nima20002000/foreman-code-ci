// CI's HTTP routes; the API registers them where it registered its own and supplies the request principal.
export { registerCircleAccountRoutes, registerComputerPreparationRoutes, registerHostCiRoutes }
  from '@foreman-code/ci/http'
