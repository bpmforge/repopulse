# A command-line tool's output IS its job: puts outside app/ is not flagged.
module Orders
  class CLI
    def run(argv)
      puts "orders #{VERSION}"
      p argv if ENV["DEBUG"]
    end
  end
end
