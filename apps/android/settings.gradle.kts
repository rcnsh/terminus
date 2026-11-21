pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("androidx\\..*")
                includeGroupByRegex("com\\.android(\\..*)?")
                includeGroupByRegex("com\\.google\\..*")
            }
        }
        mavenCentral {
            content {
                excludeGroupByRegex("androidx\\..*")
                excludeGroupByRegex("com\\.android(\\..*)?")
            }
        }
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google {
            content {
                includeGroupByRegex("androidx\\..*")
                includeGroupByRegex("com\\.android(\\..*)?")
                includeGroupByRegex("com\\.google\\..*")
            }
        }
        mavenCentral {
            content {
                excludeGroupByRegex("androidx\\..*")
                excludeGroupByRegex("com\\.android(\\..*)?")
            }
        }
    }
}

rootProject.name = "terminus"

include(":app")
