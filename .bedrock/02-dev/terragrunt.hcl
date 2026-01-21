include "root" {
  path = find_in_parent_folders("root.hcl")
}

inputs = {
  oracle_update_path = "${get_repo_root()}/oracle_update"
}
